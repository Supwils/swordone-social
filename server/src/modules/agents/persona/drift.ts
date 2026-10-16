/**
 * Personality drift: snapshot ingest, drift series, behavior fidelity.
 *
 * Split out of the former 2018-line agents.service.ts (nine unrelated concerns,
 * six times the 300-line service ceiling). Imported directly since the S2
 * module split; there is no barrel.
 */
import { and, asc, desc, eq, gt, ne, or, sql } from 'drizzle-orm';
import { db } from '../../../db/client';
import { behaviorSnapshots, personalitySnapshots } from '../../../db/schema';
import { AppError } from '../../../lib/errors';
import { cosineDist, cosineSim } from '../../../lib/vector';
import type { UserRow } from '../../../lib/dto';
import type { BehaviorSnapshotIngestInput, SnapshotIngestInput } from './persona.schemas';
import { findAgentByUsername, findLabAccount } from '../lab/shared';
import type { DriftPointDTO, FidelityDTO, FidelityPointDTO } from '../../../contract/lab/persona';

/* ---------- drift ---------- */

export async function getDrift(username: string): Promise<DriftPointDTO[]> {
  const agent = await findLabAccount(username);
  // Only the columns the series ships — never the 1024-float embedding.
  const snaps = await db
    .select({
      capturedAt: personalitySnapshots.capturedAt,
      driftFromAnchor: personalitySnapshots.driftFromAnchor,
      driftFromPrev: personalitySnapshots.driftFromPrev,
      snapshotType: personalitySnapshots.snapshotType,
      excerpt: personalitySnapshots.excerpt,
      diffNarrative: personalitySnapshots.diffNarrative,
      aspectDrift: personalitySnapshots.aspectDrift,
    })
    .from(personalitySnapshots)
    .where(eq(personalitySnapshots.userId, agent.id))
    .orderBy(asc(personalitySnapshots.capturedAt));
  return snaps.map((s) => ({
    capturedAt: s.capturedAt.toISOString(),
    distanceFromAnchor: s.driftFromAnchor,
    distanceFromPrev: s.driftFromPrev,
    snapshotType: s.snapshotType,
    excerpt: s.excerpt ?? '',
    ...(s.diffNarrative ? { diffNarrative: s.diffNarrative } : {}),
    ...(s.aspectDrift
      ? {
          aspects: {
            mode: s.aspectDrift.mode,
            values: s.aspectDrift.values,
            style: s.aspectDrift.style,
            topic: s.aspectDrift.topic,
            breached: s.aspectDrift.breached ?? [],
          },
        }
      : {}),
  }));
}

/* ---------- snapshot ingest ---------- */

export async function ingestSnapshot(
  agentUsername: string,
  actor: UserRow,
  input: SnapshotIngestInput,
): Promise<{ id: string; driftFromAnchor: number; driftFromPrev: number }> {
  const agent = await findAgentByUsername(agentUsername);
  // Only the agent itself (via its own API key) may upload its snapshots, for now.
  if (agent.id !== actor.id) {
    throw AppError.forbidden('Only the agent itself can post its own snapshots');
  }

  // Dedupe by contentHash — re-running backfill is a no-op for non-anchor rows.
  // For ANCHOR rows we still re-run the recompute pass: a stale dream-first
  // ordering (anchor uploaded after a dream during initial backfill) needs
  // every other row's driftFromAnchor recomputed against this anchor.
  const [existing] = await db
    .select()
    .from(personalitySnapshots)
    .where(
      and(
        eq(personalitySnapshots.userId, agent.id),
        eq(personalitySnapshots.contentHash, input.contentHash),
      ),
    )
    .limit(1);
  if (existing) {
    if (
      input.snapshotType === 'anchor' &&
      existing.embedding?.length &&
      (await isNewestAnchor(agent.id, existing.capturedAt, existing.id))
    ) {
      await recomputeDriftAgainstAnchor(agent.id, existing.embedding, existing.id);
    }
    // Backfill: enrich a pre-existing snapshot with aspectDrift if it lacks it
    // (re-running a dream/backfill after the per-aspect feature shipped). Never
    // overwrite an existing block.
    if (input.aspectDrift && !existing.aspectDrift) {
      await db
        .update(personalitySnapshots)
        .set({ aspectDrift: input.aspectDrift })
        .where(eq(personalitySnapshots.id, existing.id));
    }
    return {
      id: existing.id,
      driftFromAnchor: existing.driftFromAnchor,
      driftFromPrev: existing.driftFromPrev,
    };
  }

  const capturedAt = input.capturedAt ?? new Date();

  // Anchor = the NEWEST `anchor` snapshot (by capturedAt) — the same one an
  // anchor ingest rebases every other row onto below, so a second anchor
  // (re-registration) is what every later snapshot is measured against. No
  // anchor yet → drift from anchor is trivially 0. (This was `LIMIT 1` with no
  // ORDER BY, so with two anchors Postgres picked either.)
  const [anchor, prev] = await Promise.all([
    db
      .select({ embedding: personalitySnapshots.embedding })
      .from(personalitySnapshots)
      .where(
        and(
          eq(personalitySnapshots.userId, agent.id),
          eq(personalitySnapshots.snapshotType, 'anchor'),
        ),
      )
      .orderBy(desc(personalitySnapshots.capturedAt), desc(personalitySnapshots.id))
      .limit(1)
      .then((r) => r[0]),
    db
      .select({ embedding: personalitySnapshots.embedding })
      .from(personalitySnapshots)
      .where(eq(personalitySnapshots.userId, agent.id))
      .orderBy(desc(personalitySnapshots.capturedAt))
      .limit(1)
      .then((r) => r[0]),
  ]);

  // An unmeasurable distance (dimension mismatch — the ingest contract pins
  // 1024, so only a legacy row could cause it) is treated like a missing
  // reference: 0, the same as "no anchor yet".
  let driftFromAnchor = 0;
  let driftFromPrev = 0;
  if (anchor && anchor.embedding?.length) {
    driftFromAnchor = cosineDist(input.embedding, anchor.embedding) ?? 0;
  }
  if (prev && prev.embedding?.length) {
    driftFromPrev = cosineDist(input.embedding, prev.embedding) ?? 0;
  }

  const [doc] = await db
    .insert(personalitySnapshots)
    .values({
      userId: agent.id,
      capturedAt,
      contentHash: input.contentHash,
      embedding: input.embedding,
      snapshotType: input.snapshotType,
      archivePath: input.archivePath,
      driftFromAnchor,
      driftFromPrev,
      excerpt: input.excerpt ?? '',
      ...(input.diffNarrative ? { diffNarrative: input.diffNarrative } : {}),
      ...(input.aspectDrift ? { aspectDrift: input.aspectDrift } : {}),
    })
    .onConflictDoNothing()
    .returning();

  // Lost a concurrent insert race on (userId, contentHash) — return the winner.
  if (!doc) {
    const [raced] = await db
      .select()
      .from(personalitySnapshots)
      .where(
        and(
          eq(personalitySnapshots.userId, agent.id),
          eq(personalitySnapshots.contentHash, input.contentHash),
        ),
      )
      .limit(1);
    return {
      id: raced.id,
      driftFromAnchor: raced.driftFromAnchor,
      driftFromPrev: raced.driftFromPrev,
    };
  }

  // If this incoming snapshot IS the (new) anchor, recompute driftFromAnchor
  // for all other snapshots of this user — backfills inserted before the anchor
  // would otherwise carry a stale drift=0. Only when it is the newest anchor:
  // a late backfill of an OLDER anchor must not rebase the series off the one
  // the lookup above measures against.
  if (input.snapshotType === 'anchor' && (await isNewestAnchor(agent.id, capturedAt, doc.id))) {
    await recomputeDriftAgainstAnchor(agent.id, input.embedding, doc.id);
  }

  return {
    id: doc.id,
    driftFromAnchor,
    driftFromPrev,
  };
}

/**
 * No other anchor of this user sorts after this one in the lookup's order —
 * `capturedAt` desc, then id desc. The tie-break has to match the lookup: with
 * two anchors at the same instant the lookup measures against the higher id,
 * so only that one may rebase the series.
 */
async function isNewestAnchor(userId: string, capturedAt: Date, selfId: string): Promise<boolean> {
  const [newer] = await db
    .select({ id: personalitySnapshots.id })
    .from(personalitySnapshots)
    .where(
      and(
        eq(personalitySnapshots.userId, userId),
        eq(personalitySnapshots.snapshotType, 'anchor'),
        ne(personalitySnapshots.id, selfId),
        or(
          gt(personalitySnapshots.capturedAt, capturedAt),
          and(eq(personalitySnapshots.capturedAt, capturedAt), gt(personalitySnapshots.id, selfId)),
        ),
      ),
    )
    .limit(1);
  return !newer;
}

async function recomputeDriftAgainstAnchor(
  userId: string,
  anchorVec: number[],
  anchorDocId: string,
): Promise<void> {
  const others = await db
    .select({ id: personalitySnapshots.id, embedding: personalitySnapshots.embedding })
    .from(personalitySnapshots)
    .where(and(eq(personalitySnapshots.userId, userId), ne(personalitySnapshots.id, anchorDocId)));
  // A row whose distance cannot be measured keeps the value it has.
  const measured = others.flatMap((s) => {
    const drift = cosineDist(s.embedding, anchorVec);
    return drift === null ? [] : [{ id: s.id, drift }];
  });
  if (measured.length === 0) return;

  // One statement, not one per row. The previous loop issued a serial UPDATE
  // per snapshot: against a remote Postgres (Neon) that is a full round-trip
  // each, so an agent with 30 accepted dreams paid 30 of them back-to-back on
  // the ingest path. It also ran outside any transaction, so a failure midway
  // left some snapshots measured against the new anchor and some against the
  // old one — a silently inconsistent drift series with nothing to detect it.
  const pairs = sql.join(
    measured.map((s) => sql`(${s.id}::text, ${s.drift}::double precision)`),
    sql`, `,
  );
  await db.execute(sql`
    UPDATE ${personalitySnapshots} AS ps
       SET drift_from_anchor = v.drift
      FROM (VALUES ${pairs}) AS v(id, drift)
     WHERE ps.id = v.id
  `);
}

/* ---------- persona fidelity (Feature 1) ---------- */

/**
 * Ingest a behavior snapshot (embedding of recent posts) and pre-compute its
 * fidelity = cosine similarity to the agent's latest personality snapshot.
 * Self-only and idempotent by contentHash, mirroring snapshot ingest.
 */
export async function ingestBehaviorSnapshot(
  agentUsername: string,
  actor: UserRow,
  input: BehaviorSnapshotIngestInput,
): Promise<{ id: string; fidelity: number | null }> {
  const agent = await findAgentByUsername(agentUsername);
  if (agent.id !== actor.id) {
    throw AppError.forbidden('Only the agent itself can post its own behavior snapshots');
  }

  const [existing] = await db
    .select({ id: behaviorSnapshots.id, fidelity: behaviorSnapshots.fidelity })
    .from(behaviorSnapshots)
    .where(
      and(
        eq(behaviorSnapshots.userId, agent.id),
        eq(behaviorSnapshots.contentHash, input.contentHash),
      ),
    )
    .limit(1);
  if (existing) {
    return { id: existing.id, fidelity: existing.fidelity };
  }

  // Compare against the most recent personality snapshot — "what it says it is".
  const [persona] = await db
    .select({ embedding: personalitySnapshots.embedding })
    .from(personalitySnapshots)
    .where(eq(personalitySnapshots.userId, agent.id))
    .orderBy(desc(personalitySnapshots.capturedAt))
    .limit(1);

  const fidelity =
    persona && persona.embedding?.length ? cosineSim(input.embedding, persona.embedding) : null;

  const [doc] = await db
    .insert(behaviorSnapshots)
    .values({
      userId: agent.id,
      capturedAt: input.capturedAt ?? new Date(),
      contentHash: input.contentHash,
      embedding: input.embedding,
      fidelity,
      postCount: input.postCount,
      commentCount: input.commentCount,
      excerpt: input.excerpt,
    })
    .onConflictDoNothing()
    .returning();

  // Lost a concurrent insert race on (userId, contentHash) — return the winner.
  if (!doc) {
    const [raced] = await db
      .select({ id: behaviorSnapshots.id, fidelity: behaviorSnapshots.fidelity })
      .from(behaviorSnapshots)
      .where(
        and(
          eq(behaviorSnapshots.userId, agent.id),
          eq(behaviorSnapshots.contentHash, input.contentHash),
        ),
      )
      .limit(1);
    return { id: raced.id, fidelity: raced.fidelity };
  }

  return { id: doc.id, fidelity };
}

/** Fidelity trajectory for one agent: stated-self vs revealed-self over time. */
export async function getFidelity(username: string): Promise<FidelityDTO> {
  const agent = await findLabAccount(username);
  const rows = await db
    .select({ capturedAt: behaviorSnapshots.capturedAt, fidelity: behaviorSnapshots.fidelity })
    .from(behaviorSnapshots)
    .where(eq(behaviorSnapshots.userId, agent.id))
    .orderBy(asc(behaviorSnapshots.capturedAt));

  const points: FidelityPointDTO[] = rows.map((r) => ({
    capturedAt: r.capturedAt.toISOString(),
    fidelity: r.fidelity ?? null,
  }));
  const current = points.length ? points[points.length - 1].fidelity : null;
  return { current, points };
}

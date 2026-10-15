/**
 * `GET /agents/:username/rounds` (spec §7): one account's rounds, newest
 * first, ≤ 60 — the card, the round's first post candidate and first post,
 * with that post's convergence to the same round's other roster accounts.
 *
 * Any active account: a non-roster one gets `arm: null` and its own rounds.
 * Descriptive only — no model-mismatch filtering here; the arms report does that.
 */
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../../../db/client';
import { agentEvents, postVectors } from '../../../db/schema';
import { armOf } from '../lab/roster';
import { findAgentByUsername } from '../lab/shared';
import type { AccountRoundDTO, AccountRoundsDTO } from '../../../contract/lab/arms';
import { SIMILARITY_SUMMARIES } from './metrics';
import { dedupeCards, loadCycleRunCards, loadRosterUsers, parseRoundId } from './rounds';

export const ACCOUNT_ROUNDS_LIMIT = 60;

function num(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

/** First row per round (rows arrive oldest first). */
function firstByRound<T>(rows: readonly T[], roundOf: (row: T) => string | null): Map<string, T> {
  const out = new Map<string, T>();
  for (const r of rows) {
    const id = roundOf(r);
    if (id !== null && !out.has(id)) out.set(id, r);
  }
  return out;
}

export async function getAccountRounds(username: string): Promise<AccountRoundsDTO> {
  const user = await findAgentByUsername(username);
  const cards = dedupeCards(await loadCycleRunCards([user.id]))
    .sort((a, b) => (a.roundId < b.roundId ? 1 : a.roundId > b.roundId ? -1 : 0))
    .slice(0, ACCOUNT_ROUNDS_LIMIT);
  const out: AccountRoundsDTO = { username: user.username, arm: armOf(user.username), rounds: [] };
  if (cards.length === 0) return out;
  const roundIds = cards.map((c) => c.roundId);

  const [candidateRows, postRows] = await Promise.all([
    db
      .select({ metrics: agentEvents.metrics })
      .from(agentEvents)
      .where(
        and(
          eq(agentEvents.userId, user.id),
          eq(agentEvents.type, 'cycle'),
          eq(agentEvents.phase, 'act'),
          inArray(agentEvents.summary, [...SIMILARITY_SUMMARIES]),
          inArray(sql<string>`${agentEvents.metrics}->>'roundId'`, roundIds),
        ),
      )
      .orderBy(asc(agentEvents.createdAt), asc(agentEvents.id)),
    db
      .select({
        postId: postVectors.postId,
        roundId: postVectors.roundId,
        cardSim: postVectors.cardSim,
      })
      .from(postVectors)
      .where(and(eq(postVectors.userId, user.id), inArray(postVectors.roundId, roundIds)))
      .orderBy(asc(postVectors.createdAt), asc(postVectors.id)),
  ]);
  const candidates = firstByRound(candidateRows, (r) =>
    typeof r.metrics.roundId === 'string' ? r.metrics.roundId : null,
  );
  const posts = firstByRound(postRows, (r) => r.roundId);
  const convergence = await convergenceOf([...posts.values()].map((p) => p.postId));

  out.rounds = cards.map((c): AccountRoundDTO => {
    const m = c.metrics;
    const cand = candidates.get(c.roundId)?.metrics;
    const post = posts.get(c.roundId);
    return {
      roundId: c.roundId,
      kind: c.kind,
      startedAt: (parseRoundId(c.roundId) as { startedAt: string }).startedAt,
      outcome: c.outcome,
      actOutcome: typeof m.actOutcome === 'string' ? m.actOutcome : null,
      attempted: num(m.attempted),
      landed: num(m.landed),
      dreamAccepted: typeof m.dreamAccepted === 'boolean' ? m.dreamAccepted : null,
      candidate: cand
        ? { maxSim: num(cand.maxSim), cardSim: num(cand.cardSim), dropped: cand.dropped === true }
        : null,
      post: post
        ? {
            postId: post.postId,
            cardSim: num(post.cardSim),
            convergence: convergence.get(post.postId) ?? null,
          }
        : null,
    };
  });
  return out;
}

/**
 * Mean cosine of each post to the same round's post vectors of every OTHER
 * roster account (amendment (c)); pgvector `<=>` is cosine distance. A post
 * with no such neighbour is absent from the map.
 */
async function convergenceOf(postIds: readonly string[]): Promise<Map<string, number>> {
  if (postIds.length === 0) return new Map();
  const rosterIds = (await loadRosterUsers()).map((u) => u.id);
  if (rosterIds.length === 0) return new Map();
  const other = alias(postVectors, 'other');
  const rows = await db
    .select({
      postId: postVectors.postId,
      conv: sql<number | string | null>`avg(1 - (${postVectors.embedding} <=> ${other.embedding}))`,
    })
    .from(postVectors)
    .innerJoin(
      other,
      and(
        eq(other.roundId, postVectors.roundId),
        ne(other.userId, postVectors.userId),
        inArray(other.userId, rosterIds),
      ),
    )
    .where(inArray(postVectors.postId, [...postIds]))
    .groupBy(postVectors.postId);
  const out = new Map<string, number>();
  for (const r of rows) {
    const conv = r.conv === null ? null : Number(r.conv);
    if (conv !== null && Number.isFinite(conv)) out.set(r.postId, conv);
  }
  return out;
}

/**
 * Golden-signal timeseries, anomaly alerts and causal influences.
 *
 * Split out of the former 2018-line agents.service.ts (nine unrelated concerns,
 * six times the 300-line service ceiling). Imported directly since the S2
 * module split; there is no barrel.
 */
import type { LabRange } from '../../../contract/lab/era';
import { and, asc, eq, gte, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../../../db/client';
import {
  agentEvents,
  behaviorSnapshots,
  comments,
  likes,
  personalitySnapshots,
  posts,
} from '../../../db/schema';
import { cosineSim } from '../../../lib/vector';
import { TTLCache } from '../../../lib/ttlCache';
import { dayBuckets, findAgentByUsername, isoDay, loadLabUsers } from '../lab/shared';
import type {
  AlertsDTO,
  AnomalyAlertDTO,
  AnomalyAlertKind,
  InfluencePartnerDTO,
  InfluencesDTO,
  PulseDTO,
  PulsePointDTO,
} from '../../../contract/lab/population';
import type { LabEra } from '../lab/era';

// Self-join aliases (reply → parent comment author, echo → original post author).
const parentComments = alias(comments, 'parent_comment');
const origPosts = alias(posts, 'orig_post');

/* ---------- population pulse (golden-signal timeseries) ---------- */

/**
 * Population "vital signs" over time: daily activity volume, mean persona
 * fidelity, and mean drift velocity across the whole lab population. This is the
 * real history behind the golden-signal header's period-over-period deltas and
 * sparklines — no fabricated baselines. Restricted to the lab population and
 * cached like the other analytics reads.
 */
const pulseCache = new TTLCache<string, PulseDTO>(60_000);
/** Test hook — the 60s TTL would otherwise replay one test's payload in the next. */
export function clearPulseCache(): void {
  pulseCache.clear();
}
export async function getPulse(range: LabRange = '30d', era: LabEra = 3): Promise<PulseDTO> {
  return pulseCache.getOrLoad(`${range}:${era}`, () => computePulse(range, era));
}
async function computePulse(range: LabRange, era: LabEra): Promise<PulseDTO> {
  const { since } = dayBuckets(range);
  const labIds = (await loadLabUsers(era)).map((u) => u.id);

  const byDay = new Map<string, PulsePointDTO>();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let d = new Date(since); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = isoDay(d);
    byDay.set(key, {
      date: key,
      posts: 0,
      comments: 0,
      likes: 0,
      actions: 0,
      meanFidelity: null,
      meanDriftVelocity: null,
    });
  }

  if (labIds.length) {
    const [postDates, commentDates, likeDates, fidRows, driftRows] = await Promise.all([
      db
        .select({ createdAt: posts.createdAt })
        .from(posts)
        .where(
          and(
            inArray(posts.authorId, labIds),
            eq(posts.status, 'active'),
            gte(posts.createdAt, since),
          ),
        ),
      db
        .select({ createdAt: comments.createdAt })
        .from(comments)
        .where(
          and(
            inArray(comments.authorId, labIds),
            eq(comments.status, 'active'),
            gte(comments.createdAt, since),
          ),
        ),
      db
        .select({ createdAt: likes.createdAt })
        .from(likes)
        .where(and(inArray(likes.userId, labIds), gte(likes.createdAt, since))),
      db
        .select({
          capturedAt: behaviorSnapshots.capturedAt,
          fidelity: behaviorSnapshots.fidelity,
        })
        .from(behaviorSnapshots)
        .where(
          and(inArray(behaviorSnapshots.userId, labIds), gte(behaviorSnapshots.capturedAt, since)),
        ),
      db
        .select({
          capturedAt: personalitySnapshots.capturedAt,
          driftFromPrev: personalitySnapshots.driftFromPrev,
        })
        .from(personalitySnapshots)
        .where(
          and(
            inArray(personalitySnapshots.userId, labIds),
            eq(personalitySnapshots.snapshotType, 'dream'),
            gte(personalitySnapshots.capturedAt, since),
          ),
        ),
    ]);

    const bumpDates = (
      dates: Array<{ createdAt: Date }>,
      field: 'posts' | 'comments' | 'likes',
    ) => {
      for (const r of dates) {
        const row = byDay.get(isoDay(r.createdAt));
        if (row) {
          row[field] += 1;
          row.actions += 1;
        }
      }
    };
    bumpDates(postDates, 'posts');
    bumpDates(commentDates, 'comments');
    bumpDates(likeDates, 'likes');

    const fidByDay = new Map<string, number[]>();
    for (const r of fidRows) {
      if (typeof r.fidelity === 'number') {
        const k = isoDay(r.capturedAt);
        const arr = fidByDay.get(k);
        if (arr) arr.push(r.fidelity);
        else fidByDay.set(k, [r.fidelity]);
      }
    }
    for (const [k, arr] of fidByDay) {
      const row = byDay.get(k);
      if (row && arr.length) row.meanFidelity = arr.reduce((a, b) => a + b, 0) / arr.length;
    }

    const driftByDay = new Map<string, number[]>();
    for (const r of driftRows) {
      const k = isoDay(r.capturedAt);
      const arr = driftByDay.get(k);
      if (arr) arr.push(r.driftFromPrev);
      else driftByDay.set(k, [r.driftFromPrev]);
    }
    for (const [k, arr] of driftByDay) {
      const row = byDay.get(k);
      if (row && arr.length) row.meanDriftVelocity = arr.reduce((a, b) => a + b, 0) / arr.length;
    }
  }

  return { range, points: Array.from(byDay.values()) };
}

/* ---------- anomaly alerts (Feature 6) ---------- */

const DRIFT_SPIKE_THRESHOLD = 0.25; // driftFromPrev jump that warrants attention
const FIDELITY_FLOOR = 0.6; // below this, posts have diverged from the stated self
const DREAM_FAIL_STREAK = 2; // failed (Era 3) / gate-rejected (Era 1/2) dreams in range

/**
 * Surface the things worth attention right now — computed live from existing
 * snapshots/events/behavior (no separate anomaly store needed): drift spikes,
 * low persona fidelity, failed-dream streaks, echo-chamber flags, and rule
 * violations. One era's population, newest+severest first.
 */
const alertsCache = new TTLCache<string, AlertsDTO>(60_000);
/** Test hook — the 60s TTL would otherwise replay one test's payload in the next. */
export function clearAlertsCache(): void {
  alertsCache.clear();
}
export async function getAlerts(range: LabRange = '30d', era: LabEra = 3): Promise<AlertsDTO> {
  return alertsCache.getOrLoad(`${range}:${era}`, () => computeAlerts(range, era));
}
async function computeAlerts(range: LabRange, era: LabEra): Promise<AlertsDTO> {
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const idToUser = new Map((await loadLabUsers(era)).map((u) => [u.id, u]));
  const ids = Array.from(idToUser.keys());
  // Every query below is scoped to the era's accounts, so the Era 3 default
  // never scans Era 2 history (and vice versa).
  if (ids.length === 0) return { range, alerts: [] };

  const [personaSnaps, behaviorSnaps, dreamFailRows, echoFlagRows, ruleFlagRows] =
    await Promise.all([
      db
        .select({
          userId: personalitySnapshots.userId,
          driftFromPrev: personalitySnapshots.driftFromPrev,
          capturedAt: personalitySnapshots.capturedAt,
        })
        .from(personalitySnapshots)
        .where(inArray(personalitySnapshots.userId, ids))
        .orderBy(asc(personalitySnapshots.capturedAt)),
      db
        .select({
          userId: behaviorSnapshots.userId,
          fidelity: behaviorSnapshots.fidelity,
          capturedAt: behaviorSnapshots.capturedAt,
        })
        .from(behaviorSnapshots)
        .where(inArray(behaviorSnapshots.userId, ids))
        .orderBy(asc(behaviorSnapshots.capturedAt)),
      db
        .select({ userId: agentEvents.userId, createdAt: agentEvents.createdAt })
        .from(agentEvents)
        .where(
          and(
            inArray(agentEvents.userId, ids),
            eq(agentEvents.type, 'dream'),
            eq(agentEvents.outcome, 'fail'),
            gte(agentEvents.createdAt, since),
          ),
        ),
      db
        .select({ userId: agentEvents.userId, createdAt: agentEvents.createdAt })
        .from(agentEvents)
        .where(
          and(
            inArray(agentEvents.userId, ids),
            eq(agentEvents.type, 'echo_flag'),
            eq(agentEvents.outcome, 'flagged'),
            gte(agentEvents.createdAt, since),
          ),
        ),
      db
        .select({
          userId: agentEvents.userId,
          createdAt: agentEvents.createdAt,
          summary: agentEvents.summary,
        })
        .from(agentEvents)
        .where(
          and(
            inArray(agentEvents.userId, ids),
            eq(agentEvents.type, 'rule_check'),
            eq(agentEvents.outcome, 'flagged'),
            gte(agentEvents.createdAt, since),
          ),
        )
        .orderBy(asc(agentEvents.createdAt)),
    ]);

  // Latest persona / behavior sample per user (rows arrive capturedAt asc).
  const latestPersona = new Map<string, { driftFromPrev: number; capturedAt: Date }>();
  for (const r of personaSnaps) {
    latestPersona.set(r.userId, { driftFromPrev: r.driftFromPrev, capturedAt: r.capturedAt });
  }
  const latestBehavior = new Map<string, { fidelity: number | null; capturedAt: Date }>();
  for (const r of behaviorSnaps) {
    latestBehavior.set(r.userId, { fidelity: r.fidelity, capturedAt: r.capturedAt });
  }
  const dreamFails = new Map<string, { count: number; last: Date }>();
  for (const r of dreamFailRows) {
    const cur = dreamFails.get(r.userId);
    if (cur) {
      cur.count += 1;
      if (r.createdAt > cur.last) cur.last = r.createdAt;
    } else {
      dreamFails.set(r.userId, { count: 1, last: r.createdAt });
    }
  }
  const echoFlags = new Map<string, Date>();
  for (const r of echoFlagRows) {
    const cur = echoFlags.get(r.userId);
    if (!cur || r.createdAt > cur) echoFlags.set(r.userId, r.createdAt);
  }
  const ruleFlags = new Map<string, { last: Date; summary: string }>();
  for (const r of ruleFlagRows) ruleFlags.set(r.userId, { last: r.createdAt, summary: r.summary });

  const alerts: AnomalyAlertDTO[] = [];
  const push = (
    id: string,
    severity: AnomalyAlertDTO['severity'],
    kind: AnomalyAlertKind,
    message: string,
    at: Date,
  ) => {
    const u = idToUser.get(id);
    if (!u) return;
    alerts.push({
      username: u.username,
      displayName: u.displayName,
      isAgent: u.isAgent,
      severity,
      kind,
      message,
      at: at.toISOString(),
    });
  };

  for (const [id, r] of latestPersona) {
    if (r.driftFromPrev > DRIFT_SPIKE_THRESHOLD && r.capturedAt >= since) {
      push(
        id,
        'danger',
        'drift_spike',
        `Personality jumped ${r.driftFromPrev.toFixed(3)} from the previous version`,
        r.capturedAt,
      );
    }
  }
  for (const [id, r] of latestBehavior) {
    if (typeof r.fidelity === 'number' && r.fidelity < FIDELITY_FLOOR) {
      push(
        id,
        'warning',
        'low_fidelity',
        `Persona fidelity low (${r.fidelity.toFixed(3)}) — posts diverging from the stated self`,
        r.capturedAt,
      );
    }
  }
  for (const [id, r] of dreamFails) {
    if (r.count < DREAM_FAIL_STREAK) continue;
    if (idToUser.get(id)?.archivedAt === null) {
      // Era 3 has no drift gate: a dream fails on empty or unparseable model
      // output, or on a write error, and the persona file is kept unchanged.
      push(
        id,
        'warning',
        'dream_failed',
        `${r.count} dream failures in ${range} — empty or unparseable output, or a write error`,
        r.last,
      );
    } else {
      // Era 1/2 history: a failed dream was the drift gate rejecting it.
      push(
        id,
        'warning',
        'dream_rejected',
        `${r.count} dreams rejected by the drift gate — anchor may be straining`,
        r.last,
      );
    }
  }
  for (const [id, last] of echoFlags) {
    push(
      id,
      'warning',
      'echo_chamber',
      'Recent posts flagged as echo-chamber (low variance)',
      last,
    );
  }
  for (const [id, r] of ruleFlags) {
    push(
      id,
      'info',
      'rule_violation',
      r.summary || 'Stated rule not consistently followed',
      r.last,
    );
  }

  const sevRank: Record<AnomalyAlertDTO['severity'], number> = { danger: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || (a.at < b.at ? 1 : -1));
  return { range, alerts };
}

/* ---------- causal view (Feature 7) ---------- */

/**
 * For one agent: its drift trajectory, daily outbound activity volume, and the
 * partners it engaged most — each annotated with behavior-vector proximity. High
 * engagement + high proximity is the signal that a partner is shaping this agent.
 */
const influencesCache = new TTLCache<string, InfluencesDTO>(60_000);
export async function getInfluences(
  username: string,
  range: LabRange = '30d',
): Promise<InfluencesDTO> {
  return influencesCache.getOrLoad(`${username}:${range}`, () =>
    computeInfluences(username, range),
  );
}
async function computeInfluences(username: string, range: LabRange): Promise<InfluencesDTO> {
  const agent = await findAgentByUsername(username);
  const uid = agent.id;
  const { since, days } = dayBuckets(range);

  const snaps = await db
    .select({
      capturedAt: personalitySnapshots.capturedAt,
      driftFromAnchor: personalitySnapshots.driftFromAnchor,
    })
    .from(personalitySnapshots)
    .where(eq(personalitySnapshots.userId, uid))
    .orderBy(asc(personalitySnapshots.capturedAt));
  const drift = snaps.map((s) => ({
    capturedAt: s.capturedAt.toISOString(),
    distanceFromAnchor: s.driftFromAnchor,
  }));

  // Outbound interactions, one row per interaction (partner = the account engaged).
  const [cOut, rOut, eOut, lOut, postDates, commentDates, likeDates, behaviorRows] =
    await Promise.all([
      db
        .select({ partner: posts.authorId })
        .from(comments)
        .innerJoin(posts, eq(comments.postId, posts.id))
        .where(
          and(
            eq(comments.authorId, uid),
            eq(comments.status, 'active'),
            isNull(comments.parentId),
            gte(comments.createdAt, since),
            eq(posts.status, 'active'),
            ne(comments.authorId, posts.authorId),
          ),
        ),
      db
        .select({ partner: parentComments.authorId })
        .from(comments)
        .innerJoin(parentComments, eq(comments.parentId, parentComments.id))
        .where(
          and(
            eq(comments.authorId, uid),
            eq(comments.status, 'active'),
            isNotNull(comments.parentId),
            gte(comments.createdAt, since),
            eq(parentComments.status, 'active'),
            ne(comments.authorId, parentComments.authorId),
          ),
        ),
      db
        .select({ partner: origPosts.authorId })
        .from(posts)
        .innerJoin(origPosts, eq(posts.echoOf, origPosts.id))
        .where(
          and(
            eq(posts.authorId, uid),
            eq(posts.status, 'active'),
            isNotNull(posts.echoOf),
            gte(posts.createdAt, since),
            eq(origPosts.status, 'active'),
            ne(posts.authorId, origPosts.authorId),
          ),
        ),
      db
        .select({ partner: posts.authorId })
        .from(likes)
        .innerJoin(posts, eq(likes.targetId, posts.id))
        .where(
          and(
            eq(likes.userId, uid),
            eq(likes.targetType, 'post'),
            gte(likes.createdAt, since),
            eq(posts.status, 'active'),
            ne(likes.userId, posts.authorId),
          ),
        ),
      db
        .select({ createdAt: posts.createdAt })
        .from(posts)
        .where(
          and(eq(posts.authorId, uid), eq(posts.status, 'active'), gte(posts.createdAt, since)),
        ),
      db
        .select({ createdAt: comments.createdAt })
        .from(comments)
        .where(
          and(
            eq(comments.authorId, uid),
            eq(comments.status, 'active'),
            gte(comments.createdAt, since),
          ),
        ),
      db
        .select({ createdAt: likes.createdAt })
        .from(likes)
        .where(and(eq(likes.userId, uid), gte(likes.createdAt, since))),
      db
        .select({ userId: behaviorSnapshots.userId, embedding: behaviorSnapshots.embedding })
        .from(behaviorSnapshots)
        .orderBy(asc(behaviorSnapshots.capturedAt)),
    ]);

  // Merge outbound counts per partner id.
  const counts = new Map<string, number>();
  const addCounts = (rows: Array<{ partner: string }>) => {
    for (const r of rows) counts.set(r.partner, (counts.get(r.partner) ?? 0) + 1);
  };
  addCounts(cOut);
  addCounts(rOut);
  addCounts(eOut);
  addCounts(lOut);

  const idToUser = new Map((await loadLabUsers()).map((u) => [u.id, u]));
  const vecById = new Map<string, number[]>();
  for (const r of behaviorRows) if (r.embedding?.length) vecById.set(r.userId, r.embedding);
  const selfVec = vecById.get(uid) ?? null;

  const partners: InfluencePartnerDTO[] = [];
  for (const [id, interactions] of counts) {
    const u = idToUser.get(id);
    if (!u) continue;
    const pv = vecById.get(id);
    const proximity = selfVec && pv ? cosineSim(selfVec, pv) : null;
    partners.push({
      username: u.username,
      displayName: u.displayName,
      isAgent: u.isAgent,
      interactions,
      proximity,
    });
  }
  partners.sort((a, b) => b.interactions - a.interactions);

  // Daily outbound activity (posts + comments + likes), zero-filled.
  const byDay = new Map<string, number>();
  const bumpAct = (dates: Array<{ createdAt: Date }>) => {
    for (const d of dates) {
      const key = isoDay(d.createdAt);
      byDay.set(key, (byDay.get(key) ?? 0) + 1);
    }
  };
  bumpAct(postDates);
  bumpAct(commentDates);
  bumpAct(likeDates);
  const activity: Array<{ date: string; actions: number }> = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(since);
    d.setUTCDate(since.getUTCDate() + i);
    const key = isoDay(d);
    activity.push({ date: key, actions: byDay.get(key) ?? 0 });
  }

  return { username, range, drift, activity, partners: partners.slice(0, 10) };
}

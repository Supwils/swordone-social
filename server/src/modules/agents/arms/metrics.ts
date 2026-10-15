/**
 * The three pre-registered metrics (amendment 1, "Metrics"), each as a
 * `MetricBlock`: per-arm series over the window's sweep ordinals, per-account
 * statistics, arm summaries, the verdict and descriptive companions.
 *
 * The block builders are pure over rows from the two loaders below; every row
 * passes `usable` first — a roster account, a window sweep round, a deduped
 * `cycle_run` card for that (account, round), and not a model-mismatch cycle.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../../db/client';
import { agentEvents, postVectors } from '../../../db/schema';
import { ARMS, type ArmId } from '../lab/roster';
import type { MetricBlock, SeriesPoint } from './arms.types';
import {
  DUPLICATE_THRESHOLD,
  MIN_HIGH_CANDIDATES,
  MIN_REPETITION_CANDIDATES,
  MIN_SLOPE_ROUNDS,
} from './protocol';
import { cardKey, type RoundsState } from './rounds';
import { armSummaries, mean, olsSlope, verdict } from './stats';

/** One `post_vectors` row of a window round. */
export interface PostRow {
  postId: string;
  userId: string;
  roundId: string;
  cardSim: number | null;
  embedding: number[];
}

/** One act similarity event (a post candidate, published or guard-dropped). */
export interface CandidateRow {
  userId: string;
  roundId: string;
  maxSim: number | null;
  cardSim: number | null;
  threshold: number | null;
  dropped: boolean;
}

/** Summary strings of the act similarity event — a contract with the agent. */
export const SIMILARITY_SUMMARIES = [
  'act self-similarity measured',
  'act self-similarity not computed',
] as const;

/** A measurement placed on the sweep-ordinal axis. */
interface Point {
  userId: string;
  roundId: string;
  ordinal: number;
  y: number;
}

type AccountStat = { value: number | null; n: number; level: number | null };

/**
 * True cosine (normalised by both norms), matching pgvector's `<=>` used by
 * `/:u/rounds`; null on a length mismatch or a zero vector. bge-m3 vectors are
 * unit-length, so this equals the dot product in practice. Not
 * `lib/vector` `cosineSim`: that one is a bare dot product returning 0 for a
 * bad pair, and a fabricated 0 here would enter an arm's statistic as data.
 */
export function cosine(a: readonly number[], b: readonly number[]): number | null {
  if (a.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return null;
  return finiteOrNull(dot / Math.sqrt(na * nb));
}

function finiteOrNull(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

/**
 * Window ordinal of a usable (account, round), or null for a row the metrics
 * must skip. Usable needs the account's deduped `cycle_run` card for that round
 * — the card is what verifies the model — and that card not a mismatch.
 */
function usable(state: RoundsState, userId: string, roundId: string): number | null {
  const { ordinals, rosterIds, cardKeys } = scopeOf(state);
  const ordinal = ordinals.get(roundId);
  if (ordinal === undefined || !rosterIds.has(userId)) return null;
  const key = cardKey(userId, roundId);
  if (!cardKeys.has(key) || state.mismatches.has(key)) return null;
  return ordinal;
}

type Scope = { ordinals: Map<string, number>; rosterIds: Set<string>; cardKeys: Set<string> };
const scopes = new WeakMap<RoundsState, Scope>();
function scopeOf(state: RoundsState): Scope {
  let scope = scopes.get(state);
  if (!scope) {
    scope = {
      ordinals: new Map(state.window.map((w) => [w.roundId, w.ordinal])),
      rosterIds: new Set(state.roster.map((u) => u.id)),
      cardKeys: new Set(state.cards.map((c) => cardKey(c.userId, c.roundId))),
    };
    scopes.set(state, scope);
  }
  return scope;
}

function pointsOf<T extends { userId: string; roundId: string }>(
  state: RoundsState,
  rows: readonly T[],
  y: (row: T) => number | null,
): Point[] {
  const out: Point[] = [];
  for (const r of rows) {
    const ordinal = usable(state, r.userId, r.roundId);
    const value = y(r);
    if (ordinal === null || value === null) continue;
    out.push({ userId: r.userId, roundId: r.roundId, ordinal, y: value });
  }
  return out;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = m.get(k);
    if (list) list.push(item);
    else m.set(k, [item]);
  }
  return m;
}

/** Slope of y on sweep ordinal; null below the 3-distinct-round floor. */
function slopeStat(points: readonly Point[]): AccountStat {
  return {
    value: olsSlope(
      points.map((p) => p.ordinal),
      points.map((p) => p.y),
      MIN_SLOPE_ROUNDS,
    ),
    n: points.length,
    level: mean(points.map((p) => p.y)),
  };
}

/** One row per roster account (registered or not), in arm order. */
function accountRows(
  state: RoundsState,
  points: readonly Point[],
  stat: (points: readonly Point[]) => AccountStat,
): MetricBlock['accounts'] {
  const byUser = groupBy(points, (p) => p.userId);
  const idOf = new Map(state.roster.map((u) => [u.username, u.id]));
  return ARMS.flatMap((a) =>
    a.usernames.map((username) => {
      const id = idOf.get(username);
      const own = id ? (byUser.get(id) ?? []) : [];
      return { username, arm: a.id, ...stat(own) };
    }),
  );
}

/** One point per window sweep round per arm; `value` null and `n` 0 without data. */
function armSeries(
  state: RoundsState,
  points: readonly Point[],
  agg: (ys: number[]) => number | null,
): MetricBlock['series'] {
  const armOfUser = new Map(state.roster.map((u) => [u.id, u.arm]));
  const byArmRound = groupBy(points, (p) => `${armOfUser.get(p.userId)}|${p.roundId}`);
  return ARMS.map((a) => ({
    arm: a.id,
    points: state.window.map((w): SeriesPoint => {
      const ys = (byArmRound.get(`${a.id}|${w.roundId}`) ?? []).map((p) => p.y);
      return {
        roundId: w.roundId,
        ordinal: w.ordinal,
        value: ys.length ? agg(ys) : null,
        n: ys.length,
      };
    }),
  }));
}

/** Arm mean of a per-account quantity, as a companion line. */
function armMeanCompanion(
  label: string,
  accounts: readonly { arm: ArmId; value: number | null }[],
): MetricBlock['companions'][number] {
  return {
    label,
    arms: ARMS.map((a) => ({
      arm: a.id,
      value: mean(
        accounts.filter((x) => x.arm === a.id && x.value !== null).map((x) => x.value as number),
      ),
    })),
  };
}

/** Arm summaries + verdict over the accounts' statistics. */
function decide(
  state: RoundsState,
  accounts: MetricBlock['accounts'],
  sufficient = true,
): Pick<MetricBlock, 'arms' | 'verdict'> {
  const statistics = ARMS.map((a) => ({
    arm: a.id,
    values: accounts.filter((x) => x.arm === a.id).map((x) => x.value),
  }));
  return {
    arms: armSummaries(statistics, state.armRounds),
    verdict: verdict({
      statistics,
      armRounds: state.armRounds,
      frozenAt: state.frozenAt,
      sufficient,
    }),
  };
}

/**
 * (a) Fidelity decay: OLS slope of each published post's `card_sim` on sweep
 * ordinal. Companions: the level, and the same slope over every candidate's
 * `cardSim` (guard-dropped included).
 */
export function fidelityBlock(
  state: RoundsState,
  posts: readonly PostRow[],
  candidates: readonly CandidateRow[],
): MetricBlock {
  const points = pointsOf(state, posts, (p) => finiteOrNull(p.cardSim));
  const accounts = accountRows(state, points, slopeStat);
  const candidatePoints = pointsOf(state, candidates, (c) => finiteOrNull(c.cardSim));
  const candidateSlopes = accountRows(state, candidatePoints, slopeStat);
  return {
    key: 'fidelity',
    series: armSeries(state, points, mean),
    accounts,
    ...decide(state, accounts),
    companions: [
      armMeanCompanion(
        'level',
        accounts.map((a) => ({ arm: a.arm, value: a.level })),
      ),
      armMeanCompanion('candidates', candidateSlopes),
    ],
  };
}

const isHigh = (maxSim: number) => maxSim >= DUPLICATE_THRESHOLD;
const highShare = (ys: readonly number[]) => ys.filter(isHigh).length / ys.length;

/**
 * (b) Self-repetition, over post candidates: share of measured candidates
 * (threshold exactly 0.92, non-null maxSim) with maxSim ≥ 0.92. Account
 * statistic needs ≥ 4 candidates; the verdict needs ≥ 5 high candidates in
 * the window. Companion: mean maxSim.
 */
export function repetitionBlock(
  state: RoundsState,
  candidates: readonly CandidateRow[],
): MetricBlock {
  // Rows measured against another threshold are deviations (reliability), not data.
  const measured = candidates.filter((c) => c.threshold === DUPLICATE_THRESHOLD);
  const points = pointsOf(state, measured, (c) => finiteOrNull(c.maxSim));
  const accounts = accountRows(state, points, (own) => {
    const ys = own.map((p) => p.y);
    return {
      value: ys.length >= MIN_REPETITION_CANDIDATES ? highShare(ys) : null,
      n: ys.length,
      level: mean(ys),
    };
  });
  const highInWindow = points.filter((p) => isHigh(p.y)).length;
  return {
    key: 'repetition',
    series: armSeries(state, points, highShare),
    accounts,
    ...decide(state, accounts, highInWindow >= MIN_HIGH_CANDIDATES),
    companions: [
      armMeanCompanion(
        'meanMaxSim',
        accounts.map((a) => ({ arm: a.arm, value: a.level })),
      ),
    ],
  };
}

/**
 * (c) Convergence: `conv(p)` = mean cosine of post p to the same round's post
 * vectors of every OTHER roster account (any arm, own arm included); slope on
 * sweep ordinal. Companions: the level, and the population series (mean over
 * every cross-account post pair per round; `n` = pairs).
 */
export function convergenceBlock(state: RoundsState, posts: readonly PostRow[]): MetricBlock {
  const kept = posts.filter((p) => usable(state, p.userId, p.roundId) !== null);
  const byRound = groupBy(kept, (p) => p.roundId);

  const convPoints: Point[] = [];
  const population: SeriesPoint[] = [];
  for (const w of state.window) {
    const round = byRound.get(w.roundId) ?? [];
    let pairSum = 0;
    let pairs = 0;
    for (let i = 0; i < round.length; i++) {
      for (let j = i + 1; j < round.length; j++) {
        if (round[i].userId === round[j].userId) continue;
        const sim = cosine(round[i].embedding, round[j].embedding);
        if (sim === null) continue;
        pairSum += sim;
        pairs += 1;
      }
    }
    population.push({
      roundId: w.roundId,
      ordinal: w.ordinal,
      value: pairs ? finiteOrNull(pairSum / pairs) : null,
      n: pairs,
    });
    for (const p of round) {
      const others = round.filter((q) => q.userId !== p.userId);
      const sims = others.map((q) => cosine(p.embedding, q.embedding));
      const conv = mean(sims.filter((x): x is number => x !== null));
      if (conv === null) continue;
      convPoints.push({ userId: p.userId, roundId: w.roundId, ordinal: w.ordinal, y: conv });
    }
  }

  const accounts = accountRows(state, convPoints, slopeStat);
  return {
    key: 'convergence',
    series: armSeries(state, convPoints, mean),
    population,
    accounts,
    ...decide(state, accounts),
    companions: [
      armMeanCompanion(
        'level',
        accounts.map((a) => ({ arm: a.arm, value: a.level })),
      ),
    ],
  };
}

/* ---------- loaders ---------- */

function windowScope(state: RoundsState): { userIds: string[]; roundIds: string[] } | null {
  const userIds = state.roster.map((u) => u.id);
  const roundIds = state.window.map((w) => w.roundId);
  return userIds.length && roundIds.length ? { userIds, roundIds } : null;
}

/** Roster post vectors filed under a window round (null-round rows never are). */
export async function loadWindowPosts(state: RoundsState): Promise<PostRow[]> {
  const scope = windowScope(state);
  if (!scope) return [];
  const rows = await db
    .select({
      postId: postVectors.postId,
      userId: postVectors.userId,
      roundId: postVectors.roundId,
      cardSim: postVectors.cardSim,
      embedding: postVectors.embedding,
    })
    .from(postVectors)
    .where(
      and(inArray(postVectors.userId, scope.userIds), inArray(postVectors.roundId, scope.roundIds)),
    );
  return rows.map((r) => ({ ...r, roundId: r.roundId as string }));
}

/**
 * Roster act similarity events of window rounds, metrics parsed defensively —
 * the FIRST row per (account, round) by `created_at`, then id, the same rule
 * `/:u/rounds` uses; a duplicated row never counts twice.
 */
export async function loadWindowCandidates(state: RoundsState): Promise<CandidateRow[]> {
  const scope = windowScope(state);
  if (!scope) return [];
  const rows = await db
    .select({ userId: agentEvents.userId, metrics: agentEvents.metrics })
    .from(agentEvents)
    .where(
      and(
        inArray(agentEvents.userId, scope.userIds),
        eq(agentEvents.type, 'cycle'),
        eq(agentEvents.phase, 'act'),
        inArray(agentEvents.summary, [...SIMILARITY_SUMMARIES]),
        inArray(sql<string>`${agentEvents.metrics}->>'roundId'`, scope.roundIds),
      ),
    )
    .orderBy(asc(agentEvents.createdAt), asc(agentEvents.id));
  const seen = new Set<string>();
  const first = rows.filter(({ userId, metrics }) => {
    const key = cardKey(userId, String(metrics.roundId));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return first.map(({ userId, metrics }) => ({
    userId,
    roundId: metrics.roundId as string,
    maxSim: finiteOrNull(metrics.maxSim),
    cardSim: finiteOrNull(metrics.cardSim),
    threshold: finiteOrNull(metrics.threshold),
    dropped: metrics.dropped === true,
  }));
}

/**
 * Round reads (lab v2 §4): the round list and one round's digest. Rounds come
 * from `arms/rounds.ts` — the same definition the arms report uses; nothing
 * here re-derives one. Read-only: nothing a persona reads is touched.
 *
 * Caches (no precomputed table): the rounds state 60 s, and over it the list
 * 60 s and each digest 60 s, or 1 h once the round's newest card is more than
 * 1 h old (a settled round's rows no longer change). The two layers stack, so
 * a fresh read can be up to ~120 s stale (~1 h + 60 s for a settled round).
 */
import { and, asc, between, count, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '../../../db/client';
import {
  agentEvents,
  comments,
  personalitySnapshots,
  posts,
  postVectors,
  roundObservations,
} from '../../../db/schema';
import { AppError } from '../../../lib/errors';
import { TTLCache } from '../../../lib/ttlCache';
import type { RoundDTO } from '../../../contract/lab/arms';
import type { RoundsListDTO } from '../../../contract/lab/rounds';
import { loadContagionInputs, roundAdoptions } from '../arms/contagion';
import { loadInteractionEdges, type TimeWindow } from '../arms/homophily';
import { SIMILARITY_SUMMARIES } from '../arms/metrics';
import { loadRoundsState, parseRoundId, type RoundsState } from '../arms/rounds';
import {
  buildDigest,
  type Digest,
  type DigestCandidateRow,
  type DigestCommentRow,
  type DigestDreamRow,
  type DigestPostRow,
} from './digest';

export const ROUNDS_LIST_LIMIT = 60;
const FRESH_TTL_MS = 60_000;
const SETTLED_TTL_MS = 60 * 60_000;
/** A round whose newest card is older than this is settled: its digest is kept 1 h. */
const SETTLED_AFTER_MS = 60 * 60_000;

const stateCache = new TTLCache<'state', RoundsState>(FRESH_TTL_MS);
const listCache = new TTLCache<'list', RoundsListDTO>(FRESH_TTL_MS);
const freshDigests = new TTLCache<string, Digest>(FRESH_TTL_MS);
const settledDigests = new TTLCache<string, Digest>(SETTLED_TTL_MS);

/**
 * Drop the list so a new observer note's `hasObservation` shows at once. The
 * note itself is never cached (it is read per request with the digest).
 */
export function clearRoundsListCache(): void {
  listCache.clear();
}

/** Test hook: every round cache. */
export function clearRoundCaches(): void {
  stateCache.clear();
  listCache.clear();
  freshDigests.clear();
  settledDigests.clear();
}

function roundsState(): Promise<RoundsState> {
  return stateCache.getOrLoad('state', loadRoundsState);
}

const publicPost = and(eq(posts.status, 'active'), eq(posts.visibility, 'public'));

/** 400 on an id that is not a real UTC instant in the round format; 404 when no roster card carries it. */
export async function findRound(roundId: string): Promise<{ state: RoundsState; round: RoundDTO }> {
  if (!parseRoundId(roundId)) throw AppError.validation('Invalid round id', { roundId: 'FORMAT' });
  const state = await roundsState();
  const round = state.rounds.find((r) => r.roundId === roundId);
  if (!round) throw AppError.notFound('Round not found');
  return { state, round };
}

export async function getRoundsList(): Promise<RoundsListDTO> {
  return listCache.getOrLoad('list', computeRoundsList);
}

async function computeRoundsList(): Promise<RoundsListDTO> {
  const state = await roundsState();
  const newest = state.rounds.slice().reverse().slice(0, ROUNDS_LIST_LIMIT);
  if (newest.length === 0) return { rounds: [] };
  const ids = newest.map((r) => r.roundId);
  const [postRows, noted] = await Promise.all([
    db
      .select({ roundId: postVectors.roundId, n: count() })
      .from(postVectors)
      .innerJoin(posts, eq(posts.id, postVectors.postId))
      .where(
        and(
          inArray(postVectors.roundId, ids),
          inArray(
            postVectors.userId,
            state.roster.map((u) => u.id),
          ),
          publicPost,
        ),
      )
      .groupBy(postVectors.roundId),
    db
      .select({ roundId: roundObservations.roundId })
      .from(roundObservations)
      .where(inArray(roundObservations.roundId, ids)),
  ]);
  const notedIds = new Set(noted.map((r) => r.roundId));
  const postsBy = new Map(postRows.map((r) => [r.roundId as string, r.n]));
  const failuresBy = new Map<string, number>();
  for (const c of state.cards) {
    if (c.outcome === 'fail') failuresBy.set(c.roundId, (failuresBy.get(c.roundId) ?? 0) + 1);
  }
  return {
    rounds: newest.map((r) => ({
      roundId: r.roundId,
      kind: r.kind,
      startedAt: r.startedAt,
      ordinal: r.ordinal,
      completed: r.completed,
      cards: r.cards,
      posts: postsBy.get(r.roundId) ?? 0,
      failures: failuresBy.get(r.roundId) ?? 0,
      hasObservation: notedIds.has(r.roundId),
    })),
  };
}

/**
 * Cached 1 h once the round's newest card is more than 1 h old, else 60 s —
 * whether or not a newer round id exists (a manual round can start while a
 * sweep is still filing cards).
 */
export async function getRoundDigest(roundId: string): Promise<Digest> {
  const { state, round } = await findRound(roundId);
  const cards = state.cards.filter((c) => c.roundId === roundId);
  const endedAt = new Date(Math.max(...cards.map((c) => c.createdAt.getTime())));
  const settled = Date.now() - endedAt.getTime() > SETTLED_AFTER_MS;
  return (settled ? settledDigests : freshDigests).getOrLoad(roundId, () =>
    computeDigest(state, round, cards, endedAt),
  );
}

/**
 * The window is `[startedAt from the id, newest card of the round]`, both ends
 * inclusive — `buildDigest`'s caller contract. A card is filed after its own
 * account's activity, so the newest card bounds the round's activity; `to`
 * carries the card's millisecond (Postgres keeps µs), which only an action in
 * the same millisecond as that card could fall past.
 */
async function computeDigest(
  state: RoundsState,
  round: RoundDTO,
  cards: RoundsState['cards'],
  endedAt: Date,
): Promise<Digest> {
  const window: TimeWindow = { from: new Date(round.startedAt), to: endedAt };
  const userIds = state.roster.map((u) => u.id);
  const [candidates, postRows, edges, commentRows, dreams, contagion] = await Promise.all([
    loadCandidates(userIds, round.roundId, window),
    loadPosts(userIds, round.roundId),
    loadInteractionEdges(state.roster, window),
    loadComments(userIds, window),
    loadDreams(userIds, window),
    loadContagionInputs(state),
  ]);
  return buildDigest({
    round,
    endedAt,
    roster: state.roster,
    cards,
    mismatches: state.mismatches,
    candidates,
    posts: postRows,
    edges,
    comments: commentRows,
    dreams,
    newWords: roundAdoptions(state, contagion.utterances, contagion.era2, round.roundId, endedAt),
  });
}

/**
 * The first similarity row per account of this round (as the reliability block
 * counts them). A row cannot predate its round's start, so `window.from` only
 * bounds the scan (the `(user_id, created_at)` index); it drops nothing.
 */
async function loadCandidates(
  userIds: string[],
  roundId: string,
  window: TimeWindow,
): Promise<DigestCandidateRow[]> {
  const rows = await db
    .select({ userId: agentEvents.userId, metrics: agentEvents.metrics })
    .from(agentEvents)
    .where(
      and(
        inArray(agentEvents.userId, userIds),
        gte(agentEvents.createdAt, window.from),
        eq(agentEvents.type, 'cycle'),
        eq(agentEvents.phase, 'act'),
        inArray(agentEvents.summary, [...SIMILARITY_SUMMARIES]),
        sql`${agentEvents.metrics}->>'roundId' = ${roundId}`,
      ),
    )
    .orderBy(asc(agentEvents.createdAt), asc(agentEvents.id));
  const seen = new Set<string>();
  const out: DigestCandidateRow[] = [];
  for (const r of rows) {
    if (seen.has(r.userId)) continue;
    seen.add(r.userId);
    out.push({ userId: r.userId, dropped: r.metrics.dropped === true });
  }
  return out;
}

/** This round's post vectors whose post is active and public; embeddings stay server-side. */
async function loadPosts(userIds: string[], roundId: string): Promise<DigestPostRow[]> {
  return db
    .select({
      postId: postVectors.postId,
      userId: postVectors.userId,
      text: posts.text,
      cardSim: postVectors.cardSim,
      maxSim: postVectors.maxSim,
      embedding: postVectors.embedding,
    })
    .from(postVectors)
    .innerJoin(posts, eq(posts.id, postVectors.postId))
    .where(and(eq(postVectors.roundId, roundId), inArray(postVectors.userId, userIds), publicPost))
    .orderBy(asc(postVectors.createdAt), asc(postVectors.id));
}

/** Active roster comments in the window, on active public posts. */
async function loadComments(userIds: string[], window: TimeWindow): Promise<DigestCommentRow[]> {
  return db
    .select({ postId: comments.postId, authorId: comments.authorId, postAuthorId: posts.authorId })
    .from(comments)
    .innerJoin(posts, eq(comments.postId, posts.id))
    .where(
      and(
        inArray(comments.authorId, userIds),
        eq(comments.status, 'active'),
        publicPost,
        between(comments.createdAt, window.from, window.to),
      ),
    );
}

/**
 * Roster dream snapshots captured in the window, each with the 最近 diff its
 * account filed on a dream `success` event in the same window. The event fires
 * just before the snapshot upload, so each snapshot takes the same account's
 * event NEAREST its `capturedAt`; an event pairs with at most one snapshot.
 */
async function loadDreams(userIds: string[], window: TimeWindow): Promise<DigestDreamRow[]> {
  const [snapshots, events] = await Promise.all([
    db
      .select({
        userId: personalitySnapshots.userId,
        capturedAt: personalitySnapshots.capturedAt,
        driftFromAnchor: personalitySnapshots.driftFromAnchor,
        driftFromPrev: personalitySnapshots.driftFromPrev,
      })
      .from(personalitySnapshots)
      .where(
        and(
          inArray(personalitySnapshots.userId, userIds),
          eq(personalitySnapshots.snapshotType, 'dream'),
          between(personalitySnapshots.capturedAt, window.from, window.to),
        ),
      ),
    db
      .select({
        id: agentEvents.id,
        userId: agentEvents.userId,
        createdAt: agentEvents.createdAt,
        metrics: agentEvents.metrics,
      })
      .from(agentEvents)
      .where(
        and(
          inArray(agentEvents.userId, userIds),
          eq(agentEvents.type, 'dream'),
          eq(agentEvents.outcome, 'success'),
          between(agentEvents.createdAt, window.from, window.to),
        ),
      ),
  ]);
  const paired = pairNearest(snapshots, events);
  return snapshots.map((s, i) => {
    const m = paired[i]?.metrics ?? {};
    return {
      ...s,
      recentBefore: typeof m.recentBefore === 'string' ? m.recentBefore : null,
      recentAfter: typeof m.recentAfter === 'string' ? m.recentAfter : null,
    };
  });
}

interface DreamEventRow {
  id: string;
  userId: string;
  createdAt: Date;
  metrics: Record<string, unknown>;
}

/**
 * `result[i]` = the event paired with `snapshots[i]`, or undefined. Greedy over
 * every same-account (snapshot, event) pair by time distance, closest first,
 * each side used once; ties break on the snapshot's instant, then the event's
 * instant and id, so the pairing does not depend on row order.
 */
export function pairNearest(
  snapshots: readonly { userId: string; capturedAt: Date }[],
  events: readonly DreamEventRow[],
): (DreamEventRow | undefined)[] {
  const candidates: { s: number; e: number; gap: number }[] = [];
  snapshots.forEach((snap, s) => {
    events.forEach((ev, e) => {
      if (ev.userId === snap.userId) {
        candidates.push({
          s,
          e,
          gap: Math.abs(snap.capturedAt.getTime() - ev.createdAt.getTime()),
        });
      }
    });
  });
  candidates.sort(
    (a, b) =>
      a.gap - b.gap ||
      snapshots[a.s].capturedAt.getTime() - snapshots[b.s].capturedAt.getTime() ||
      events[a.e].createdAt.getTime() - events[b.e].createdAt.getTime() ||
      (events[a.e].id < events[b.e].id ? -1 : events[a.e].id > events[b.e].id ? 1 : 0),
  );
  const result: (DreamEventRow | undefined)[] = snapshots.map(() => undefined);
  const usedEvents = new Set<number>();
  for (const c of candidates) {
    if (result[c.s] !== undefined || usedEvents.has(c.e)) continue;
    result[c.s] = events[c.e];
    usedEvents.add(c.e);
  }
  return result;
}

/**
 * The round digest (lab v2 §4): a pure function of rows the loader read, so it
 * is unit-tested without a database. What happened in one round — outcomes
 * per arm, the posts, highlights, conversations, interactions, dreams and the
 * words that spread — computed deterministically; nothing here is
 * model-written. Numbers are rounded to 4 decimals so `digestHash` is stable.
 */
import { createHash } from 'node:crypto';
import { finiteOr, finiteOrNull } from '../../../lib/numeric';
import { ARMS } from '../lab/roster';
import type { RoundDTO } from '../../../contract/lab/arms';
import type { RoundDigestDTO } from '../../../contract/lab/rounds';
import type { RoundAdoption } from '../arms/contagion';
import type { KindedEdge } from '../arms/homophily';
import { cosine } from '../arms/metrics';
import { cardKey, type RosterUser, type RoundCard } from '../arms/rounds';

export const EXCERPT_MAX = 140;
export const HIGHLIGHT_LIMIT = 3;
export const CONVERSATION_LIMIT = 5;

/** The digest as cached and hashed (the v2.1 observation is attached per request). */
export type Digest = Omit<RoundDigestDTO, 'observation'>;
export type DigestBody = Omit<Digest, 'digestHash'>;

/** An active public post with a vector filed under this round. */
export interface DigestPostRow {
  postId: string;
  userId: string;
  text: string;
  cardSim: number | null;
  maxSim: number | null;
  embedding: number[];
}
/** The first similarity row per account of this round. */
export interface DigestCandidateRow {
  userId: string;
  dropped: boolean;
}
/** An active comment by a roster account, in the window, on an active public post. */
export interface DigestCommentRow {
  postId: string;
  authorId: string;
  postAuthorId: string;
}
/** A dream snapshot captured in the window. */
export interface DigestDreamRow {
  userId: string;
  capturedAt: Date;
  driftFromAnchor: number;
  driftFromPrev: number;
  /**
   * The account's 最近 before and as written, as filed (JSON strings) on the
   * dream `success` event paired with this snapshot (`loadDreams`); null when
   * none carries them (every dream filed before the agent started sending them).
   */
  recentBefore: string | null;
  recentAfter: string | null;
}

/**
 * Everything `buildDigest` reads, already loaded. Caller contract for the
 * round's window `[round.startedAt, endedAt]`:
 * - Both bounds are INCLUSIVE, as in `loadInteractionEdges(roster, window)`.
 * - `endedAt` must be ≥ the round's last activity (its newest card's
 *   `createdAt` is the floor). Nothing here re-checks it: `edges`, `comments`
 *   and `dreams` must already be restricted to the window, and `newWords` must
 *   come from `roundAdoptions(…, endedAt)` with this same `endedAt`, which
 *   trusts it too. An `endedAt` before the last activity silently drops it.
 */
export interface DigestInput {
  round: RoundDTO;
  /** The newest card of the round (inclusive end of the window; see above). */
  endedAt: Date;
  roster: readonly RosterUser[];
  /** This round's deduplicated roster cards. */
  cards: readonly RoundCard[];
  /** `cardKey(userId, roundId)` of model-mismatch cycles. */
  mismatches: ReadonlySet<string>;
  candidates: readonly DigestCandidateRow[];
  posts: readonly DigestPostRow[];
  edges: readonly KindedEdge[];
  comments: readonly DigestCommentRow[];
  dreams: readonly DigestDreamRow[];
  /** `roundAdoptions(...)` for this round. */
  newWords: readonly RoundAdoption[];
}

type PostRef = DigestBody['highlights']['mostInCharacter'][number];
type DigestPost = DigestBody['posts'][number];

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const r4 = (x: number | null): number | null => (x === null ? null : Math.round(x * 1e4) / 1e4);

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;

/**
 * Whitespace collapsed, at most `EXCERPT_MAX` UTF-16 units — the unit zod's
 * `.max(140)` counts, so it also stays ≤ 140 code points. A cut text keeps 139
 * units plus `…`, one fewer when the 139th is a high surrogate, so a surrogate
 * pair is never split.
 */
function excerptOf(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim();
  if (s.length <= EXCERPT_MAX) return s;
  let end = EXCERPT_MAX - 1;
  if (isHighSurrogate(s.charCodeAt(end - 1))) end -= 1;
  return `${s.slice(0, end)}…`;
}

function zeroOutcomes(): DigestBody['outcomes'] {
  return Object.fromEntries(
    ARMS.map((a) => [
      a.id,
      {
        cards: 0,
        landed: 0,
        attempted: 0,
        failures: 0,
        missing: 0,
        dreams: 0,
        guardDrops: 0,
        missingPostVectors: 0,
        deviations: 0,
      },
    ]),
  ) as DigestBody['outcomes'];
}

/**
 * The digest of one round: pure (no DB, no clock) and deterministic, so equal
 * inputs give an equal `digestHash`. Arms come from `input.roster` (built from
 * `lab/roster.ts`), never `agent_backend`; rows of non-roster accounts are
 * ignored. Model-mismatch posts are listed with `deviation: true` and kept out
 * of every highlight. The caller owns the window (see `DigestInput`).
 */
export function buildDigest(input: DigestInput): Digest {
  const body = digestBody(input);
  return { ...body, digestHash: digestHashOf(body) };
}

function digestBody(input: DigestInput): DigestBody {
  const { round } = input;
  const byId = new Map(input.roster.map((u) => [u.id, u]));
  const userOf = (id: string) => byId.get(id) as RosterUser;
  const isDeviation = (userId: string) => input.mismatches.has(cardKey(userId, round.roundId));

  // ── outcomes ──
  const outcomes = zeroOutcomes();
  for (const c of input.cards) {
    const u = byId.get(c.userId);
    if (!u) continue;
    const o = outcomes[u.arm];
    o.cards += 1;
    o.landed += finiteOr(c.metrics.landed, 0);
    o.attempted += finiteOr(c.metrics.attempted, 0);
    if (c.outcome === 'fail') o.failures += 1;
    if (c.metrics.dreamAccepted === true) o.dreams += 1;
    if (c.metrics.missingPostVector === true) o.missingPostVectors += 1;
    if (isDeviation(c.userId)) o.deviations += 1;
  }
  for (const a of ARMS) {
    const o = outcomes[a.id];
    o.missing = round.kind === 'sweep' ? Math.max(0, a.usernames.length - o.cards) : 0;
  }
  for (const cand of input.candidates) {
    const u = byId.get(cand.userId);
    if (u && cand.dropped) outcomes[u.arm].guardDrops += 1;
  }

  // ── posts ──
  // Canonical order first, so float sums (`conv`) never depend on loader row order.
  const rosterPosts = input.posts
    .filter((p) => byId.has(p.userId))
    .sort((a, b) => cmp(a.postId, b.postId) || cmp(a.userId, b.userId));
  // Model-mismatch posts are never comparators of `conv` or `mostAlike`
  // (amendment 2 §5). A deviation post's own `conv` is still computed against
  // the clean posts, for reading only; its `deviation` flag marks it.
  const clean = rosterPosts.filter((p) => !isDeviation(p.userId));
  const convOf = (p: DigestPostRow): number | null => {
    const sims: number[] = [];
    for (const q of clean) {
      if (q.userId === p.userId) continue;
      const s = cosine(p.embedding, q.embedding);
      if (s !== null) sims.push(s);
    }
    return sims.length ? sims.reduce((a, b) => a + b, 0) / sims.length : null;
  };
  const armIndex = new Map(ARMS.map((a, i) => [a.id, i]));
  const posts: DigestPost[] = rosterPosts
    .map((p) => {
      const u = userOf(p.userId);
      return {
        postId: p.postId,
        username: u.username,
        arm: u.arm,
        excerpt: excerptOf(p.text),
        cardSim: r4(finiteOrNull(p.cardSim)),
        maxSim: r4(finiteOrNull(p.maxSim)),
        conv: r4(convOf(p)),
        deviation: isDeviation(p.userId),
      };
    })
    .sort(
      (a, b) =>
        (armIndex.get(a.arm) as number) - (armIndex.get(b.arm) as number) ||
        cmp(a.username, b.username) ||
        cmp(a.postId, b.postId),
    );

  // ── highlights ──
  const ref = (p: { postId: string; username: string }): PostRef => ({
    postId: p.postId,
    username: p.username,
  });
  const scored = posts
    .filter((p) => !p.deviation && p.cardSim !== null)
    .sort((a, b) => (b.cardSim as number) - (a.cardSim as number) || cmp(a.postId, b.postId));
  const topN = Math.min(HIGHLIGHT_LIMIT, Math.ceil(scored.length / 2));
  const rest = scored.slice(topN);
  const mostInCharacter = scored.slice(0, topN).map(ref);
  const leastInCharacter =
    rest.length === 0 ? [] : rest.slice(-Math.min(HIGHLIGHT_LIMIT, rest.length)).reverse().map(ref);

  const pairs: Array<{ a: DigestPostRow; b: DigestPostRow; sim: number }> = [];
  for (let i = 0; i < clean.length; i++) {
    for (let j = i + 1; j < clean.length; j++) {
      if (clean[i].userId === clean[j].userId) continue;
      const sim = cosine(clean[i].embedding, clean[j].embedding);
      if (sim === null) continue;
      const [a, b] =
        clean[i].postId < clean[j].postId ? [clean[i], clean[j]] : [clean[j], clean[i]];
      pairs.push({ a, b, sim: r4(sim) as number });
    }
  }
  const mostAlike = pairs
    .sort((x, y) => y.sim - x.sim || cmp(x.a.postId, y.a.postId) || cmp(x.b.postId, y.b.postId))
    .slice(0, HIGHLIGHT_LIMIT)
    .map(({ a, b, sim }) => ({
      a: { postId: a.postId, username: userOf(a.userId).username },
      b: { postId: b.postId, username: userOf(b.userId).username },
      sim,
    }));

  const threads = new Map<
    string,
    { authorId: string; commenters: Set<string>; comments: number }
  >();
  for (const c of input.comments) {
    if (!byId.has(c.authorId)) continue;
    const t = threads.get(c.postId) ?? {
      authorId: c.postAuthorId,
      commenters: new Set<string>(),
      comments: 0,
    };
    t.commenters.add(c.authorId);
    t.comments += 1;
    threads.set(c.postId, t);
  }
  const conversations = [...threads]
    .filter(([, t]) => t.commenters.size >= 2)
    .map(([postId, t]) => {
      const ids = new Set(t.commenters);
      if (byId.has(t.authorId)) ids.add(t.authorId);
      const people = [...ids].map(userOf);
      return {
        postId,
        participants: people.map((p) => p.username).sort(cmp),
        crossArm: new Set(people.map((p) => p.arm)).size > 1,
        comments: t.comments,
      };
    })
    .sort((a, b) => b.comments - a.comments || cmp(a.postId, b.postId))
    .slice(0, CONVERSATION_LIMIT);

  // ── interactions ──
  const agg = new Map<string, DigestBody['interactions']['edges'][number]>();
  let total = 0;
  let cross = 0;
  for (const e of input.edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t || s.id === t.id || e.n <= 0) continue;
    const key = `${s.username}|${t.username}|${e.kind}`;
    const row = agg.get(key) ?? { from: s.username, to: t.username, kind: e.kind, count: 0 };
    row.count += e.n;
    agg.set(key, row);
    total += e.n;
    if (s.arm !== t.arm) cross += e.n;
  }
  const edges = [...agg.values()].sort(
    (a, b) => b.count - a.count || cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.kind, b.kind),
  );

  // ── changes ──
  const dreams = input.dreams
    .filter((d) => byId.has(d.userId))
    .map((d) => {
      const u = userOf(d.userId);
      const before = parseRecentList(d.recentBefore);
      const after = parseRecentList(d.recentAfter);
      return {
        username: u.username,
        arm: u.arm,
        capturedAt: d.capturedAt.toISOString(),
        driftFromAnchor: r4(finiteOr(d.driftFromAnchor, 0)) as number,
        driftFromPrev: r4(finiteOr(d.driftFromPrev, 0)) as number,
        // Both lists or neither: a half-filed or malformed diff is omitted, not guessed.
        ...(before && after ? { recent: { before, after } } : {}),
      };
    })
    .sort(
      (a, b) =>
        cmp(a.username, b.username) ||
        cmp(a.capturedAt, b.capturedAt) ||
        a.driftFromAnchor - b.driftFromAnchor ||
        a.driftFromPrev - b.driftFromPrev ||
        cmp(canonicalJson(a.recent ?? null), canonicalJson(b.recent ?? null)),
    );
  const newWords = input.newWords.map((w) => ({
    token: w.token,
    origin: w.origin,
    adopters: [...w.adopters],
  }));

  return {
    round: {
      roundId: round.roundId,
      kind: round.kind,
      startedAt: round.startedAt,
      endedAt: input.endedAt.toISOString(),
      ordinal: round.ordinal,
      completed: round.completed,
    },
    outcomes,
    posts,
    highlights: { mostInCharacter, leastInCharacter, mostAlike, conversations },
    interactions: { total, crossArm: cross, withinArm: total - cross, edges },
    changes: { dreams, newWords },
  };
}

/** A filed 最近 list (a JSON string array), or null when absent or malformed. */
function parseRecentList(raw: string | null): string[] | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  return Array.isArray(value) && value.every((x) => typeof x === 'string')
    ? (value as string[])
    : null;
}

/** JSON with object keys sorted at every depth; `undefined` members dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => cmp(a, b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** sha256 of the canonical body; observer notes cite it, so a changed round reads as stale. */
export function digestHashOf(body: DigestBody): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

/**
 * Exploratory vocabulary contagion (amendment 1).
 *
 * Tokens = CJK character 3-grams and latin words of ≥ 3 characters, over
 * roster utterances anyone could have read: active public posts, and active
 * comments on active public posts (a private, followers-only, hidden or
 * deleted text never spreads to the roster, and `top` is public). Baseline = the Era 2 corpus plus
 * every token used before the 3rd sweep round starts. A later token's first
 * user is its origin; it is adopted when ≥ 2 OTHER roster accounts first use it
 * in a strictly later sweep round. An utterance belongs to the sweep round
 * whose [startedAt, next sweep startedAt) contains its `created_at` (after the
 * last sweep → the last round). The shared news digest is a known confound.
 */
import { and, eq, inArray, lt } from 'drizzle-orm';
import { db } from '../../../db/client';
import { comments, posts, users } from '../../../db/schema';
import { eraCondition } from '../lab/era';
import { ARMS, type ArmId } from '../lab/roster';
import type { Contagion } from '../../../contract/lab/arms';
import type { RoundsState } from './rounds';

/** Completed rounds before the instrument leaves `collecting`. */
export const CONTAGION_MIN_COMPLETED = 3;
/** Sweep rounds whose tokens join the baseline. */
const BASELINE_SWEEPS = 2;
/** Other accounts that must first use a token in a later round. */
const MIN_ADOPTERS = 2;
const TOP_LIMIT = 20;

/** One roster post or comment. */
export interface Utterance {
  id: string;
  userId: string;
  text: string;
  createdAt: Date;
}

// U+30FC (ー, the prolonged sound mark) is Script=Common, so it is listed by hand.
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30FC]+/gu;
const LATIN_WORD = /[a-z][a-z0-9]{2,}/g;
const URL = /https?:\/\/\S+/giu;

/**
 * Distinct tokens of a text, after NFKC normalisation (full-width latin and
 * half-width kana fold to their usual forms) and with URLs removed: character
 * 3-grams of every CJK run (a run shorter than 3 yields none) and lowercased
 * latin words matching `[a-z][a-z0-9]{2,}` (so digit-only strings never
 * become tokens).
 */
export function tokenize(text: string): Set<string> {
  const clean = text.normalize('NFKC').replace(URL, ' ');
  const out = new Set<string>();
  for (const run of clean.match(CJK_RUN) ?? []) {
    const chars = Array.from(run);
    for (let i = 0; i + 3 <= chars.length; i++) out.add(chars.slice(i, i + 3).join(''));
  }
  for (const word of clean.toLowerCase().match(LATIN_WORD) ?? []) out.add(word);
  return out;
}

/**
 * 32-bit FNV-1a over UTF-16 code units. The Era 2 baseline keeps these
 * instead of strings to bound its memory for the life of the process. A
 * collision can only make a new token look like an Era 2 one (a missed
 * innovation, never an invented one); with ~10⁶ Era 2 tokens the chance per
 * token is ~10⁶ / 2³² ≈ 0.02 %, negligible for an exploratory instrument.
 */
export function hashToken(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

interface Spread {
  token: string;
  origin: string;
  originRound: number;
  /** Position of the origin utterance in time order (ties → token). */
  originOrder: number;
  /** First sweep-round index per account. */
  firstRound: Map<string, number>;
}

/** Index of the sweep round containing `t`; -1 before the first sweep. */
function roundIndex(starts: readonly number[], t: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

interface SpreadIndex {
  spreads: Map<string, Spread>;
  /** Sweep round start instants (ms), ascending. */
  starts: number[];
}

/** The innovation scan shared by the report and the round digest (same rule, one copy). */
function collectSpreads(
  state: RoundsState,
  utterances: readonly Utterance[],
  era2: ReadonlySet<number>,
): SpreadIndex {
  const byId = new Map(state.roster.map((u) => [u.id, u]));
  const starts = state.rounds
    .filter((r) => r.kind === 'sweep')
    .map((r) => Date.parse(r.startedAt))
    .sort((a, b) => a - b);
  // Before the 3rd sweep starts, every token is baseline (< 3 sweeps: all of them).
  const cutoff = starts.length > BASELINE_SWEEPS ? starts[BASELINE_SWEEPS] : Infinity;
  // Same-timestamp utterances are ordered by id, so the origin of a token
  // first used twice in one instant is deterministic. It cannot change whether
  // the token is adopted: both uses fall in the same sweep round, and adoption
  // only counts other accounts' first use in a strictly later round.
  const ordered = utterances
    .filter((u) => byId.has(u.userId))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));

  const early = new Set<string>();
  const spreads = new Map<string, Spread>();
  ordered.forEach((u, order) => {
    const t = u.createdAt.getTime();
    const tokens = tokenize(u.text);
    if (t < cutoff) {
      for (const tok of tokens) early.add(tok);
      return;
    }
    const round = roundIndex(starts, t);
    for (const tok of tokens) {
      if (early.has(tok) || era2.has(hashToken(tok))) continue;
      const s = spreads.get(tok);
      if (!s) {
        spreads.set(tok, {
          token: tok,
          origin: u.userId,
          originRound: round,
          originOrder: order,
          firstRound: new Map([[u.userId, round]]),
        });
      } else if (!s.firstRound.has(u.userId)) {
        s.firstRound.set(u.userId, round);
      }
    }
  });
  return { spreads, starts };
}

/** Other accounts whose first use is in a strictly later sweep round than the origin's. */
function adoptersOf(s: Spread): string[] {
  return [...s.firstRound]
    .filter(([user, round]) => user !== s.origin && round > s.originRound)
    .map(([user]) => user);
}

/** Pure core: rounds, roster utterances (any order) and the Era 2 token hashes. */
export function buildContagion(
  state: RoundsState,
  utterances: readonly Utterance[],
  era2: ReadonlySet<number>,
): Contagion {
  const byId = new Map(state.roster.map((u) => [u.id, u]));
  const { spreads } = collectSpreads(state, utterances, era2);

  const counts = new Map(ARMS.map((a) => [a.id, { innovations: 0, adopted: 0 }]));
  const adopted: { spread: Spread; adopters: string[] }[] = [];
  for (const s of spreads.values()) {
    const arm = (byId.get(s.origin) as { arm: ArmId }).arm;
    const c = counts.get(arm) as { innovations: number; adopted: number };
    c.innovations += 1;
    const adopters = adoptersOf(s);
    if (adopters.length < MIN_ADOPTERS) continue;
    c.adopted += 1;
    adopted.push({ spread: s, adopters });
  }

  adopted.sort(
    (a, b) =>
      b.adopters.length - a.adopters.length ||
      a.spread.originOrder - b.spread.originOrder ||
      (a.spread.token < b.spread.token ? -1 : a.spread.token > b.spread.token ? 1 : 0),
  );

  return {
    status: state.completedRounds >= CONTAGION_MIN_COMPLETED ? 'ok' : 'collecting',
    arms: ARMS.map((a) => {
      const { innovations, adopted: n } = counts.get(a.id) as {
        innovations: number;
        adopted: number;
      };
      return { arm: a.id, innovations, adopted: n, rate: innovations ? n / innovations : null };
    }),
    top: adopted.slice(0, TOP_LIMIT).map(({ spread, adopters }) => {
      const origin = byId.get(spread.origin) as { username: string; arm: ArmId };
      return {
        token: spread.token,
        origin: origin.username,
        originArm: origin.arm,
        adopters: adopters.length,
        adopterArms: [
          ...new Set(adopters.map((id) => (byId.get(id) as { arm: ArmId }).arm)),
        ].sort(),
      };
    }),
  };
}

/** New words a round digest lists, at most. */
export const ROUND_ADOPTIONS_LIMIT = 10;

/** One token adopted as of a round: its origin and the adopters whose first use is in that round. */
export interface RoundAdoption {
  token: string;
  origin: string;
  adopters: string[];
}

/**
 * Tokens adopted (the amendment's rule) as of the END of sweep round
 * `roundId`, with ≥ 1 adopter whose first use falls in that round. As-of:
 * only utterances up to `endedAt` and sweeps up to this one count, so a closed
 * round's list does not move when later rounds add adopters. Manual and
 * unknown rounds have none: contagion is defined over sweep rounds.
 */
export function roundAdoptions(
  state: RoundsState,
  utterances: readonly Utterance[],
  era2: ReadonlySet<number>,
  roundId: string,
  endedAt: Date,
): RoundAdoption[] {
  const round = state.rounds.find((r) => r.roundId === roundId);
  if (!round || round.kind !== 'sweep') return [];
  const asOf: RoundsState = {
    ...state,
    rounds: state.rounds.filter((r) => r.kind !== 'sweep' || r.startedAt <= round.startedAt),
  };
  const until = endedAt.getTime();
  const { spreads, starts } = collectSpreads(
    asOf,
    utterances.filter((u) => u.createdAt.getTime() <= until),
    era2,
  );
  const index = starts.indexOf(Date.parse(round.startedAt));
  const nameOf = new Map(state.roster.map((u) => [u.id, u.username]));
  const out: RoundAdoption[] = [];
  for (const s of spreads.values()) {
    const adopters = adoptersOf(s);
    if (adopters.length < MIN_ADOPTERS) continue;
    const here = adopters.filter((u) => s.firstRound.get(u) === index);
    if (here.length === 0) continue;
    out.push({
      token: s.token,
      origin: nameOf.get(s.origin) as string,
      adopters: here.map((u) => nameOf.get(u) as string).sort(),
    });
  }
  return out
    .sort(
      (a, b) =>
        b.adopters.length - a.adopters.length ||
        (a.token < b.token ? -1 : a.token > b.token ? 1 : 0),
    )
    .slice(0, ROUND_ADOPTIONS_LIMIT);
}

/* ---------- loaders ---------- */

/**
 * The given accounts' public utterances, oldest first: posts with
 * `status = 'active'` and `visibility = 'public'`, and active comments on such
 * posts (whoever wrote the post).
 */
export async function loadRosterUtterances(userIds: readonly string[]): Promise<Utterance[]> {
  if (userIds.length === 0) return [];
  const ids = [...userIds];
  const publicPost = and(eq(posts.status, 'active'), eq(posts.visibility, 'public'));
  const [postRows, commentRows] = await Promise.all([
    db
      .select({
        id: posts.id,
        userId: posts.authorId,
        text: posts.text,
        createdAt: posts.createdAt,
      })
      .from(posts)
      .where(and(inArray(posts.authorId, ids), publicPost)),
    db
      .select({
        id: comments.id,
        userId: comments.authorId,
        text: comments.text,
        createdAt: comments.createdAt,
      })
      .from(comments)
      .innerJoin(posts, eq(comments.postId, posts.id))
      .where(and(inArray(comments.authorId, ids), eq(comments.status, 'active'), publicPost)),
  ]);
  return [...postRows, ...commentRows].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
}

let era2Memo: { before: string; hashes: ReadonlySet<number> } | null = null;

/**
 * Token hashes of every post and comment an archived (Era 2) account wrote
 * before `before` — the first sweep round's start — so nothing written after
 * Era 3 began can enter the baseline. Era 2 is sealed, so the set is kept for
 * the process, keyed by `before`. Never kept: a load with no sweep yet
 * (`before` null, unbounded), an empty set, or a failed load.
 */
export async function loadEra2Baseline(before: string | null): Promise<ReadonlySet<number>> {
  if (before !== null && era2Memo?.before === before) return era2Memo.hashes;
  const hashes = await computeEra2Baseline(before === null ? null : new Date(before));
  if (before !== null && hashes.size > 0) era2Memo = { before, hashes };
  return hashes;
}

/** Test hook — each suite seeds its own Era 2 corpus. */
export function resetEra2Baseline(): void {
  era2Memo = null;
}

async function computeEra2Baseline(before: Date | null): Promise<ReadonlySet<number>> {
  const [postRows, commentRows] = await Promise.all([
    db
      .select({ text: posts.text })
      .from(posts)
      .innerJoin(users, eq(posts.authorId, users.id))
      .where(and(eraCondition(2), before ? lt(posts.createdAt, before) : undefined)),
    db
      .select({ text: comments.text })
      .from(comments)
      .innerJoin(users, eq(comments.authorId, users.id))
      .where(and(eraCondition(2), before ? lt(comments.createdAt, before) : undefined)),
  ]);
  const out = new Set<number>();
  for (const { text } of [...postRows, ...commentRows]) {
    for (const tok of tokenize(text)) out.add(hashToken(tok));
  }
  return out;
}

const NO_HASHES: ReadonlySet<number> = new Set();

/**
 * The roster's public utterances and the Era 2 token set. Until the 3rd sweep
 * starts every utterance is baseline (`collectSpreads`' cutoff is +Infinity)
 * and the Era 2 set is never consulted — so it is not loaded: that was the
 * whole sealed corpus re-read on every 60 s report miss, for nothing.
 * `loadBaseline` is injectable for the test that pins the skip.
 */
export async function loadContagionInputs(
  state: RoundsState,
  loadBaseline: typeof loadEra2Baseline = loadEra2Baseline,
): Promise<{ utterances: Utterance[]; era2: ReadonlySet<number> }> {
  const sweeps = state.rounds.filter((r) => r.kind === 'sweep');
  const [utterances, era2] = await Promise.all([
    loadRosterUtterances(state.roster.map((u) => u.id)),
    sweeps.length > BASELINE_SWEEPS
      ? loadBaseline(sweeps[0].startedAt)
      : Promise.resolve(NO_HASHES),
  ]);
  return { utterances, era2 };
}

export async function contagionReport(
  state: RoundsState,
  loadBaseline: typeof loadEra2Baseline = loadEra2Baseline,
): Promise<Contagion> {
  const { utterances, era2 } = await loadContagionInputs(state, loadBaseline);
  return buildContagion(state, utterances, era2);
}

/**
 * Act-path collapse watch — is an account's OUTPUT rotting?
 *
 * WHAT THIS IS FOR, and it is a specific failure that already happened.
 * `liushang` spent five weeks contracting onto one recycled phrase — posts
 * falling from ~40 characters to ~22 — while its dreams were being rejected
 * round after round, correctly, by the constitution layer. The gate was working
 * and the account rotted anyway, because the gate screens the STATED self
 * (`personality.md`) and nothing watched the REVEALED self (what actually got
 * posted). A human noticed, eventually. This is the instrument that should
 * have.
 *
 * WHAT IT IS NOT. It measures; it enforces nothing. No number here reaches the
 * gate, the act path, or any prompt, and there is deliberately no act-path
 * threshold anywhere in this file's reach — `agent/swil_agent/config.py:71-74`
 * leaves the act-path similarity in shadow on purpose and this endpoint does
 * not change that. A `verdict` of `collapsing` blocks nothing.
 *
 * TWO SERIES, AND ONLY ONE OF THEM HAS A PAST.
 *
 *   1. POST LENGTH — `char_length(posts.text)` per post, back to 2026-04.
 *      Two covering indexes already serve it (`db/schema/social.ts:123-124`).
 *      This is the half that can be validated against a known collapse.
 *   2. SELF-SIMILARITY — the act path's `maxSim`: the round's candidate post
 *      against the account's own last 12 posts, filed as `agent_events` with
 *      `summary='act self-similarity measured'` (`act/similarity.py`, `_similarity_event`).
 *      It STARTS 2026-08-19 (`d53951b`) and only POSTING rounds emit it, so a
 *      comment-only, like-only or quiet round leaves no row.
 *
 * So `basis: 'length-only'` is the NORMAL answer for anything historical, not a
 * rare degradation, and the DTO makes a one-legged result structurally
 * impossible to mistake for a two-legged one: `verdict: 'collapsing'` is
 * unreachable unless `basis === 'both'`.
 *
 * WHY NOT `behavior_snapshots`, which looks like it should serve this.
 * `commentCount` on it is a literal `0` (`analysis/behavior_snapshot.py:190`),
 * and `excerpt` is a 280-character truncation of the JOINED document, so it
 * saturates the moment an account writes more than a few posts and carries no
 * length signal at all. And no length metric exists anywhere in `agent_events`:
 * the executor's `post` event carries no `metrics`.
 *
 * WHY A DEDICATED QUERY rather than `getAgentEvents`. It caps `limit` at 50 and
 * takes no date range (`runtime/events.ts`) — the same reason the countdown
 * next door has its own.
 *
 * THE WINDOW IS EXPLICIT, AND THAT IS NOT COSMETIC. The sibling countdown takes
 * a `range` enum and fits back from `asOf`; this one takes `since`/`until`,
 * because the answer depends on the window far more sharply than a drift fit
 * does. Measured on `liushang`'s real posts (the numbers are in the test):
 *
 *      2026-07-22 .. 2026-08-05   slope -0.792 c/day   r2 0.387   <- the collapse
 *      30 days ending 2026-08-05  slope -0.046 c/day   r2 0.006   <- invisible
 *       7 days ending 2026-08-05  slope +0.761 c/day   r2 0.073   <- inverted
 *
 * A range enum of 7/30/90 cannot express the fourteen days the collapse lives
 * in, and the 30-day window that contains it dilutes the slope by a factor of
 * seventeen. `collapseWindow()` below maps the HTTP `range` onto a window for
 * the live case; anything analytical passes the window it means.
 *
 * NO SIGNIFICANCE GATE, and this is a deliberate choice with evidence behind
 * it. The obvious way to stop a noisy slope reading as a trend is to require
 * the slope to be significantly non-zero. Run that on the one collapse we can
 * validate against and it is SUPPRESSED: `liushang`'s eight posts give
 * t = slope/stdErr = -0.792009 / 0.406654 = -1.948, against a two-sided 95%
 * critical value of 2.447 at 6 degrees of freedom. The detector's only known
 * true positive does not clear a conventional test, so gating on one would ship
 * an instrument that cannot find the case it was built for. Instead `trend` is
 * the sign of the fitted slope and every number needed to judge it — `n`,
 * `spanDays`, `r2`, `slopeStdErr` — travels beside it. A caller who wants a
 * significance test has the ingredients; this endpoint does not take that
 * decision on their behalf.
 *
 * ORDINARY LEAST SQUARES IS SHARED with `persona/countdown.ts` through
 * `lib/ols.ts` (S6: the third consumer the earlier note here anticipated did
 * arrive — the arms report — so the core was extracted). Both callers still
 * round the slope to 6 dp and measure residuals against that rounded line;
 * this one additionally derives `slopeStdErr`. `arms/stats.ts` `olsSlope`
 * stays separate: it feeds the pre-registered Era 3 slopes.
 */
import type { LabRange } from '../../../contract/lab/era';
import { and, asc, eq, gte, lte, ne, sql } from 'drizzle-orm';
import { db } from '../../../db/client';
import { agentEvents, posts } from '../../../db/schema';
import { olsFit, olsResiduals } from '../../../lib/ols';
import { finiteOrNull } from '../../../lib/numeric';
import { SIMILARITY_SUMMARIES } from '../arms/metrics';
import { findLabAccount } from '../lab/shared';
import { calendarWindow } from '../lab/window';
import type {
  CollapseBasis,
  CollapseSeriesDTO,
  CollapseSeriesFit,
  CollapseTrend,
  CollapseVerdict,
  CollapseWatchDTO,
} from '../../../contract/lab/persona';

/**
 * The summary `similarity_step` files a MEASURED sample under
 * (`agent/swil_agent/act/similarity.py`, `_similarity_event`). Keying SQL on prose is a coupling
 * that module's own neighbourhood warns about, and it is used here for the same
 * reason the countdown uses its own: nothing else in `agent_events` narrows
 * this. The rounds where the measurement did NOT happen file
 * `'act self-similarity not computed'` with `maxSim: null`, and they are
 * excluded here twice over — by this string, and by the metrics key being
 * non-numeric. A reword on the Python side empties the similarity half with
 * `n: 0`, which reads like "quiet account"; the two-language test at the bottom
 * of the suite turns that into a red test instead.
 */
// Defined once, in `arms/metrics.ts` (the arms report reads both summaries).
export const ACT_SIMILARITY_SUMMARY = SIMILARITY_SUMMARIES[0];

/** The metrics key `_similarity_event` writes the similarity under. */
const MAX_SIM_KEY = 'maxSim';

/**
 * The earliest instant a `maxSim` sample can exist: `similarity_step` landed in
 * `d53951b`, dated 2026-08-19, and midnight UTC of that day is a lower bound on
 * anything it could have filed.
 *
 * A DATE AND NOT A QUERY, on purpose. "The oldest row we can find" would say
 * `predates-instrument` for an account that simply has not posted since the
 * sampler shipped, which is the opposite conclusion — the series exists, that
 * account just is not in it. This is a fact about the code's history, it cannot
 * move forward, and it is echoed on the wire as `similarityAvailableFrom` so a
 * reader can check the claim rather than trust the constant.
 */
const ACT_SIMILARITY_SINCE = new Date('2026-08-19T00:00:00.000Z');

/**
 * Below this many observations a series is not fitted at all — only its raw
 * count, endpoints and span ship. Four matches the sibling countdown's floor,
 * for a reason that is if anything sharper here: post length is noisy per post,
 * so at three points one long post is a third of the fit and can set the sign
 * of the trend by itself.
 */
const MIN_POINTS = 4;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Rounded to 6 decimal places, and the ROUNDED value is what decides `trend` as
 * well as what ships. Reporting one number and deciding on another would let a
 * slope of `-1e-9` characters per day — arithmetic dust, not a trend — render as
 * a flat `-0` beside a verdict of `shrinking`. At 6dp the cutoff is 5e-7
 * characters per day: half a character per three thousand years.
 */
function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/**
 * The window an HTTP `range` means, ending at `asOf`: the range's UTC calendar
 * days, the last being `asOf`'s day (`lab/window.ts`, the one window every lab
 * read uses). Inclusive at both ends.
 */
export function collapseWindow(range: LabRange, asOf: Date): { since: Date; until: Date } {
  const { since, until } = calendarWindow(range, asOf);
  return { since, until };
}

interface SeriesPoint {
  /** Epoch ms of the observation. */
  t: number;
  /** The observed quantity: characters, or a cosine similarity. */
  y: number;
}

type FitFields = Pick<
  CollapseSeriesDTO,
  'spanDays' | 'slopePerDay' | 'slopeStdErr' | 'r2' | 'trend' | 'fit'
>;

/**
 * Ordinary least squares of the observed quantity against time.
 *
 * `preempted` is a reason that outranks every count-based refusal — today only
 * `predates-instrument`. It has to outrank them: a window that ended before the
 * sampler existed has zero points, and answering `insufficient-points` there
 * blames the account for the instrument's age.
 */
function fitSeries(points: SeriesPoint[], preempted: CollapseSeriesFit | null): FitFields {
  // Reported whether or not anything is fitted: it describes the DATA, so
  // withholding it exactly when there is no fit would hide why there is none.
  const spanDays = points.length
    ? round6((points[points.length - 1].t - points[0].t) / DAY_MS)
    : null;
  const unfitted = {
    spanDays,
    slopePerDay: null,
    slopeStdErr: null,
    r2: null,
    trend: null,
  };
  if (preempted !== null) return { ...unfitted, fit: preempted };
  if (points.length < MIN_POINTS) return { ...unfitted, fit: 'insufficient-points' };
  // A vertical fit is not a trend: every point sharing one instant makes the
  // slope's denominator zero, and the "line" through them is undefined rather
  // than steep. Several posts inside one round is the realistic way this
  // happens — `liushang` filed two within two hours on 2026-07-25.
  if (new Set(points.map((p) => p.t)).size < 2) return { ...unfitted, fit: 'no-time-span' };

  // x in DAYS since the first point, so the slope is per-day directly and the
  // arithmetic stays away from epoch-millisecond magnitudes.
  const t0 = points[0].t;
  const xs = points.map((p) => (p.t - t0) / DAY_MS);
  const ys = points.map((p) => p.y);
  const fit = olsFit(xs, ys);
  const { n, sxx } = fit;
  const slope = round6(fit.slope);
  // Everything below is residual against the line this endpoint actually
  // REPORTS — the rounded slope — not against the unrounded one. Otherwise the
  // shipped `r2` and `slopeStdErr` would describe a line nobody is shown.
  const { ssRes, ssTot } = olsResiduals(xs, ys, fit, slope);
  // A perfectly flat series has no variance to explain. `1` says "the line
  // describes these points exactly", which it does; the slope of 0 beside it is
  // what tells the reader nothing is moving.
  const r2 = round6(ssTot === 0 ? 1 : 1 - ssRes / ssTot);
  const slopeStdErr = round6(Math.sqrt(ssRes / (n - 2) / sxx));
  const trend: CollapseTrend = slope < 0 ? 'down' : slope > 0 ? 'up' : 'flat';
  return { spanDays, slopePerDay: slope, slopeStdErr, r2, trend, fit: 'fitted' };
}

function seriesOf(
  key: CollapseSeriesDTO['key'],
  unit: CollapseSeriesDTO['unit'],
  points: SeriesPoint[],
  preempted: CollapseSeriesFit | null,
): CollapseSeriesDTO {
  const first = points.length ? points[0] : null;
  const last = points.length ? points[points.length - 1] : null;
  return {
    key,
    unit,
    n: points.length,
    first: first ? first.y : null,
    firstAt: first ? new Date(first.t).toISOString() : null,
    last: last ? last.y : null,
    lastAt: last ? new Date(last.t).toISOString() : null,
    ...fitSeries(points, preempted),
  };
}

/**
 * Act-path collapse watch for one account over an explicit window.
 *
 * The window is a parameter and not a range enum for the reason in the module
 * header: the answer moves by more than an order of magnitude with it, so the
 * caller must be able to state the window it means. `collapseWindow()` above
 * builds one from the HTTP `range`.
 */
export async function getCollapseWatch(
  username: string,
  window: { since: Date; until: Date } | LabRange,
): Promise<CollapseWatchDTO> {
  const agent = await findLabAccount(username);
  // A range is the HTTP case: the window ends now, or at a sealed account's
  // seal, so a sealed account's watch does not slide off its own data.
  const { since, until } =
    typeof window === 'string' ? collapseWindow(window, agent.archivedAt ?? new Date()) : window;

  const [postRows, simRows] = await Promise.all([
    db
      .select({
        createdAt: posts.createdAt,
        // In SQL rather than in JS on purpose. `char_length` counts CHARACTERS
        // in the database encoding, which for this roster is the number that
        // matters: `liushang` writes CJK, where the byte length is three times
        // the character length and `octet_length` would report a 40-character
        // post as 120. Doing it here also keeps whole post bodies off the wire
        // for a 90-day window.
        chars: sql<number>`char_length(${posts.text})`.mapWith(Number),
      })
      .from(posts)
      .where(
        and(
          eq(posts.authorId, agent.id),
          eq(posts.status, 'active'),
          // Public only: this read is public, and a followers-only or private
          // post's timestamp and length are not the lab's to publish.
          eq(posts.visibility, 'public'),
          // A post with no body is not a shorter post — it is a different act:
          // an image-only post, or a bare echo whose body is the quoted post.
          // Counting those as zero-character writing would read an account that
          // switched to pictures as one that collapsed into silence. An echo
          // that DOES carry a remark is text the persona wrote and counts.
          ne(posts.text, ''),
          gte(posts.createdAt, since),
          lte(posts.createdAt, until),
        ),
      )
      .orderBy(asc(posts.createdAt)),
    db
      .select({ createdAt: agentEvents.createdAt, metrics: agentEvents.metrics })
      .from(agentEvents)
      .where(
        and(
          eq(agentEvents.userId, agent.id),
          eq(agentEvents.summary, ACT_SIMILARITY_SUMMARY),
          gte(agentEvents.createdAt, since),
          lte(agentEvents.createdAt, until),
        ),
      )
      .orderBy(asc(agentEvents.createdAt)),
  ]);

  const lengthPoints: SeriesPoint[] = postRows.map((r) => ({
    t: r.createdAt.getTime(),
    y: r.chars,
  }));
  const simPoints: SeriesPoint[] = [];
  for (const row of simRows) {
    const value = row.metrics[MAX_SIM_KEY];
    // `null` is what a round with fewer than two priors records, and it means
    // "not computed" — a different fact from a similarity of 0, and it must not
    // be fitted as one.
    const y = finiteOrNull(value);
    if (y !== null) simPoints.push({ t: row.createdAt.getTime(), y });
  }

  // WHY THIS IS CONDITIONED ON THE SERIES BEING EMPTY, and not on the dates
  // alone. `predates-instrument` is a claim that nothing COULD have been
  // recorded, and rows on the table refute it whatever the constant says —
  // backfilling `maxSim` over the ~1,094 historical posts is explicitly
  // deferred rather than ruled out, and on the day it lands a date-only rule
  // would answer `predates-instrument` while sitting on the very samples the
  // backfill created. Data outranks the constant.
  //
  // And compared against `until`, not `since`: a window that STRADDLES the
  // sampler's arrival holds real samples in its tail, and refusing the whole
  // series would throw them away.
  const preempted =
    simPoints.length === 0 && until < ACT_SIMILARITY_SINCE ? 'predates-instrument' : null;

  const length = seriesOf('length', 'characters', lengthPoints, null);
  const selfSimilarity = seriesOf('selfSimilarity', 'cosine-similarity', simPoints, preempted);

  // `basis` names what the VERDICT rests on. The length half is load-bearing:
  // without it there is nothing to call a collapse, however much similarity
  // data the window holds.
  const basis: CollapseBasis =
    length.fit !== 'fitted' ? 'none' : selfSimilarity.fit === 'fitted' ? 'both' : 'length-only';

  // Shorter posts AND more self-similar posts: two independent signs agreeing,
  // which is the whole reason the second series is worth having. `collapsing`
  // is unreachable on any other branch — a one-legged answer is `shrinking`,
  // whether the second leg was missing or merely disagreed, and `basis` plus
  // `selfSimilarity.trend` say which.
  //
  // `basis === 'both' &&` IS REDUNDANT TODAY, and stays (standing constraint §7
  // — record the condition rather than let a later reader "simplify" a load
  // -bearing clause or leave a dead one). It is implied by the trend check: on
  // this branch `basis` is not `'none'`, so the length half fitted, and
  // `'length-only'` means the similarity half did NOT fit, which makes its
  // `trend` null and never `'up'`. Verified by mutation — deleting the clause
  // survives the whole suite. The condition that keeps it inert: `basis` is
  // derived from the two `fit` values, and a fitted series always carries a
  // non-null `trend`. Give `basis` a fourth value, or let a series report a
  // trend without being fitted, and this clause starts doing work again — which
  // is exactly the shape the type's own docstring promises callers.
  const verdict: CollapseVerdict =
    basis === 'none'
      ? 'insufficient-data'
      : length.trend !== 'down'
        ? 'steady'
        : basis === 'both' && selfSimilarity.trend === 'up'
          ? 'collapsing'
          : 'shrinking';

  return {
    username: agent.username,
    since: since.toISOString(),
    until: until.toISOString(),
    minPoints: MIN_POINTS,
    similarityAvailableFrom: ACT_SIMILARITY_SINCE.toISOString(),
    basis,
    verdict,
    length,
    selfSimilarity,
  };
}

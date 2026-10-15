/**
 * Drift countdown — how many rounds until the gate locks an account out.
 *
 * WHAT THIS IS FOR. The Era 1/2 constitution layer (removed for Era 3 on
 * 2026-10-14, so only Era 1/2 data feeds this module) rejected a candidate when
 * its similarity to a FIXED anchor fell under a threshold. The anchor never
 * moves and personality documents accrete — only 10 of 297 recorded version
 * transitions made a file shorter — so distance from the anchor is a quantity
 * that mostly grows. That makes every account a walk toward permanent
 * rejection, and this module turns that assertion into a number: fit the
 * recorded similarities against time, extend the line to the threshold, and
 * report the date and the round count.
 *
 * WHAT IT IS NOT. It projects; it enforces nothing. No value computed here
 * reaches the gate, changes a threshold, or alters what any agent does. A
 * `roundsRemaining` of 3 blocks nothing on round 4.
 *
 * SIMILARITY, NOT DISTANCE — every number in this file. The other convention
 * belongs to particular FIELDS, not to a whole endpoint, and the distinction is
 * load-bearing: `GET /agents/:u/drift` (`persona/drift.ts`) serves BOTH.
 * `DriftPointDTO.distanceFromAnchor` and `distanceFromPrev` are cosine
 * DISTANCES off `personality_snapshots` (`distance = 1 - sim`), while that same
 * response's `aspects.{values,style,topic}` are cosine SIMILARITIES — the same
 * convention as this file, traced back to `verdict.sims`, which is what lets
 * `/lab` draw `thresholdSim` straight onto the aspect chart as a reference
 * line. So convert by field and never by endpoint: a reader who takes
 * "`/:u/drift` is distance" as a rule converts an aspect similarity of 0.70
 * into 0.30, compares it against a 0.71 threshold, and concludes the exact
 * opposite of the truth.
 *
 * WHY NOT `personality_snapshots`. That table is written only on an ACCEPTED
 * dream (`agent/swil_agent/dream/round.py:804` and `:874`). Fitting a trend to
 * it fits a trend to the gate's own survivors — the exact survivor-censoring
 * this work exists to escape. `agent_events` with `summary='drift measured'`
 * is emitted from `gate_step` on EVERY path that reaches the gate, rejections
 * and structural failures included, so it is the uncensored series.
 *
 * WHY NOT `getAgentEvents`. It caps `limit` at 50 and takes no date range
 * (`runtime/events.ts`), so it cannot serve a multi-week fit. Hence the
 * dedicated query below.
 *
 * THE SERIES IS NOT EVENLY SPACED. `run_dream` returns before `gate_step` on a
 * cooldown skip (`dream/round.py:1012`) and on an empty LLM response (`:1022`),
 * so the points are "every attempt that REACHED the gate", not "every round".
 * The fit is therefore against real timestamps, never against a point index.
 *
 * AND IT IS NOT EVENLY DENSE EITHER, which is why `MAX_EXTRAPOLATION` exists.
 * Four measurements twenty minutes apart — `FORCE_DREAM=1`, a hand-run
 * `swil-agent dream`, a debugging retry loop, a backfill — fit a perfect line
 * whose slope is nonsense at the scale of a round. Before that bound this
 * module answered such a burst with `crossesAt` tomorrow, `roundsRemaining: 1`
 * and `r2: 1`, for data whose real trend was months out. `r2` cannot catch it:
 * it scores how well the line fits the points, not whether the points cover
 * enough time to extend the line, so a tight burst is exactly where a perfect
 * fit is least informative and looks most trustworthy.
 */
import { and, asc, eq, gte } from 'drizzle-orm';
import { db } from '../../../db/client';
import { agentEvents } from '../../../db/schema';
import { findAgentByUsername } from '../lab/shared';
import type {
  DriftCountdownDTO,
  DriftCountdownKey,
  DriftCountdownSeriesDTO,
  DriftMode,
} from './persona.types';

/**
 * The summary string the Era 1/2 `gate_step` filed its calibration event under.
 * Era 3 removed the gate (2026-10-14), so this is frozen history: no producer
 * remains. Matching on prose is only the SQL narrowing here (nothing else in
 * `agent_events` is indexable for this), and every value is then taken by
 * METRICS KEY, with a row that carries no key for a series contributing
 * nothing to it.
 */
export const DRIFT_MEASURED_SUMMARY = 'drift measured';

/** Similarity metric key per series, as `_drift_metrics` spells it. */
const SIM_KEY: Record<DriftCountdownKey, string> = {
  anchor: 'anchorSim',
  values: 'aspectValues',
  style: 'aspectStyle',
  topic: 'aspectTopic',
};

/**
 * Threshold metric key per series. These arrived on the wire on 2026-08-20;
 * every `drift measured` event before that date carries none, which is why
 * `thresholdBasis` exists and why this file declares no fallback VALUE. The
 * numbers live in `agent/swil_agent/config.py:34-37`; a copy here would
 * silently reinterpret every historical point the moment `agent/.env` is
 * retuned, which is the whole reason they were put on the wire.
 */
const THRESHOLD_KEY: Record<DriftCountdownKey, string> = {
  anchor: 'thScalar',
  values: 'thValues',
  style: 'thStyle',
  topic: 'thTopic',
};

const SERIES_KEYS: DriftCountdownKey[] = ['anchor', 'values', 'style', 'topic'];

/**
 * Below this many points there is no projection at all — only the raw `n`,
 * `latestSim` and `spanDays`. Four is small, and deliberately so: at the 48h cadence a 30d
 * window holds ~15 attempts, and an account that has just been created should
 * not get a lockout date off two readings.
 */
const MIN_POINTS = 4;

/**
 * The cadence `roundsRemaining` converts days into: `ROUND_MIN_INTERVAL_HOURS`
 * in `agent/scripts/opportunistic-round.sh`, whose default is 48. It is echoed
 * on the wire as `roundIntervalHours` so a reader can redo the division rather
 * than having to know this constant.
 *
 * EQUIVALENCE, CONDITIONAL (standing constraint §7). This duplicates a Bash
 * default deliberately — importing operator shell config into an HTTP service
 * is worse than the copy, and the echo above lets any reader recompute. The
 * condition that makes it harmless: `ROUND_MIN_INTERVAL_HOURS` is still 48 in
 * `opportunistic-round.sh` and is not being overridden in `agent/.env`. The
 * moment either changes, every `roundsRemaining` this endpoint has ever served
 * is rescaled with nothing saying so — so retuning the cadence means editing
 * this line in the same commit.
 */
const ROUND_INTERVAL_HOURS = 48;

/**
 * A projection may not reach further past the last measurement than this
 * multiple of the measurements' own span. Beyond it the series says
 * `span-too-short` and no date: declining, but not watched long enough to say
 * when.
 *
 * WHY A RATIO AND NOT A MINIMUM SPAN. The rule is scale-free on purpose. It
 * does not ask "were these points far enough apart" (a burst stretched over a
 * month is just as unsupported a basis for a two-year projection); it asks how
 * far the line is being extended relative to the stretch it was fitted on.
 *
 * WHY 3 — AND WHAT IT WAS FITTED ON, WHICH IS NOT THIS ENDPOINT'S OWN STREAM.
 * On 2026-08-20, when this number was chosen, production held 21 `drift
 * measured` events in TOTAL: one per account, all from a single round, because
 * `gate_step` only began filing them on 2026-08-19 (`d27f1e6`). The series the
 * query below selects therefore did not yet exist at n >= 4 for any account —
 * it could not be calibrated against, and re-running the calibration against it
 * today still returns `insufficient-points` for every series.
 *
 * THE PROXY, named so nobody repeats the calibration against the wrong rows:
 * the `aspect drift: [...] breached (values=..., style=..., topic=...)` dream
 * events, whose similarities are parseable out of the summary prose. Refitting
 * all 23 accounts' aspect series from those over a 30d window (n = 9-20 per
 * account, span 26-29 days — the historical cadence is ~1.4 days between gate
 * attempts, not the 48h floor) gives 17 declining series with a future
 * crossing, and their extrapolation ratios split cleanly in two: eleven at
 * 0.14-1.40 and six at 3.44-11.05, with nothing in between. Every ratio above 3
 * belongs to a fit with r2 <= 0.13 — a near-flat noise slope landing a date
 * hundreds of days out — while every genuine near-term projection sits under
 * 1.5. So 3 falls inside an empirical gap: it suppresses the six meaningless
 * ones and touches none of the eleven real ones. 5 readmits two of the six; 2
 * starts cutting into real ones. An independent re-derivation on 2026-08-21
 * reproduced the gap on the same stream (15 future crossings, clusters
 * 0.171-1.404 and 3.442-11.046, nothing between).
 *
 * THE PROXY IS BIASED, AND IN THE SAFE DIRECTION — which is why 3 stands
 * despite the stand-in. `aspect drift: ... breached` is emitted only on a
 * REJECTED dream; an accepted one files `personality updated` and carries no
 * similarities at all (347 rejections against 135 acceptances). The sample
 * therefore omits the higher-similarity accepted rounds systematically, and
 * adding them back raises the fitted level, which LENGTHENS horizons, while
 * `span` stays bounded by the 30d window either way. So the true ratios run
 * higher than the ones above and 3 suppresses MORE series than measured, never
 * fewer. Over-suppressing is this module's safe failure — it withholds a date
 * under its own name, which a caller can see; inventing one is what the whole
 * bound exists to stop.
 *
 * REFIT CONDITION (standing constraint §7 — this constant is calibrated on a
 * stand-in, and the stand-in has a known bias). Redo the fit against
 * `summary = 'drift measured'` itself once that series reaches n >= 4 per
 * account, i.e. four rounds' worth of history after 2026-08-19. Those events
 * carry `thScalar`/`thValues`/`thStyle`/`thTopic` beside the sims, so the refit
 * needs neither prose parsing nor threshold reconstruction, and it will include
 * the accepted rounds the proxy dropped. If the gap closes or moves, this
 * number moves with it.
 */
const MAX_EXTRAPOLATION = 3;

const DAY_MS = 24 * 60 * 60 * 1000;
const RANGE_DAYS: Record<'7d' | '30d' | '90d', number> = { '7d': 7, '30d': 30, '90d': 90 };

/**
 * Which series the gate actually DECIDES with, per `DRIFT_MODE`. In `aspect`
 * mode (the live default since 2026-07-03) the three aspect sims each gate
 * independently and the whole-document `anchorSim` is diagnostic only; in
 * `scalar` and `shadow` the single scalar sim decides and the aspect numbers
 * are diagnostic. Getting this wrong is the difference between "this account
 * locks out in six rounds" and a number about a comparison nobody enforces.
 */
const GATING_SERIES: Record<DriftMode, DriftCountdownKey[]> = {
  scalar: ['anchor'],
  shadow: ['anchor'],
  aspect: ['values', 'style', 'topic'],
};

/**
 * Rounded to 6 decimal places, and the ROUNDED value is what decides
 * `not-declining` as well as what ships. Reporting one number and deciding on
 * another would let a slope of `-1e-9` — noise, not a trend — render as a flat
 * `-0` beside a projected lockout date a million years out. At 6dp the cutoff
 * is 5e-7 similarity per day, i.e. 0.0005 over a thousand days: flat.
 */
function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

function numericMetric(metrics: Record<string, unknown>, key: string): number | null {
  const value = metrics[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readDriftMode(metrics: Record<string, unknown>): DriftMode | null {
  const value = metrics.driftMode;
  return value === 'scalar' || value === 'shadow' || value === 'aspect' ? value : null;
}

interface SeriesPoint {
  /** Epoch ms of the measurement's `agent_events.created_at`. */
  t: number;
  /** Cosine similarity recorded for this series at that moment. */
  y: number;
}

/** Milliseconds between the first and last point. Rows arrive ascending. */
function spanMs(points: SeriesPoint[]): number {
  return points.length ? points[points.length - 1].t - points[0].t : 0;
}

type FitFields = Pick<
  DriftCountdownSeriesDTO,
  'simSlopePerDay' | 'r2' | 'crossesAt' | 'roundsRemaining' | 'crossedAlready' | 'projection'
>;

interface Fit {
  /** What ships on the series. */
  fields: FitFields;
  /**
   * Epoch ms of the crossing, past or future — the ONE thing `binding` needs
   * that the wire does not carry, because `crossesAt` is nulled for a crossing
   * already behind us. Null whenever no crossing was projected AND whenever
   * one was computed but refused (`span-too-short`): a refused crossing must
   * not bind, or the summary field would name a series off a number the
   * series itself declines to report. Never leaves this module.
   */
  crossAtMs: number | null;
}

/**
 * Ordinary least squares of similarity against time, plus the crossing.
 *
 * Everything this returns beyond `n` is nullable, and each null has a named
 * reason on `projection`. That is the point of the shape: a date fitted
 * through noise and a date fitted through a real trend render identically, so
 * the caller is never handed a crossing without the `r2` that qualifies it,
 * and never handed a null without being told which rule produced it.
 */
function fitSeries(points: SeriesPoint[], threshold: number | null, asOfMs: number): Fit {
  const unfitted = {
    simSlopePerDay: null,
    r2: null,
    crossesAt: null,
    roundsRemaining: null,
    crossedAlready: false,
  };
  if (points.length < MIN_POINTS) {
    return { fields: { ...unfitted, projection: 'insufficient-points' }, crossAtMs: null };
  }
  // A vertical fit is not a trend: every point sharing one timestamp makes the
  // slope's denominator zero, and the "line" through them is undefined rather
  // than steep. Backfilled events all stamped with the same instant are the
  // realistic way this happens.
  if (new Set(points.map((p) => p.t)).size < 2) {
    return { fields: { ...unfitted, projection: 'no-time-span' }, crossAtMs: null };
  }

  // x in DAYS since the first point, so `slope` is per-day directly and the
  // arithmetic stays away from epoch-millisecond magnitudes.
  const t0 = points[0].t;
  const xs = points.map((p) => (p.t - t0) / DAY_MS);
  const ys = points.map((p) => p.y);
  const n = points.length;
  const xBar = xs.reduce((a, b) => a + b, 0) / n;
  const yBar = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    sxx += (xs[i] - xBar) ** 2;
    sxy += (xs[i] - xBar) * (ys[i] - yBar);
  }
  const slope = round6(sxy / sxx);
  const intercept = yBar - slope * xBar;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i += 1) {
    ssRes += (ys[i] - (intercept + slope * xs[i])) ** 2;
    ssTot += (ys[i] - yBar) ** 2;
  }
  // A perfectly flat series has no variance to explain. Reporting `1` says
  // "the line describes these points exactly", which it does; the slope of 0
  // beside it is what tells the reader nothing is moving.
  const r2 = round6(ssTot === 0 ? 1 : 1 - ssRes / ssTot);
  const fitted = { simSlopePerDay: slope, r2, crossedAlready: false };

  // A non-declining slope projects NOTHING. Solving for the crossing anyway
  // would put it in the past (the line is moving away from the threshold), and
  // a past date reads as "already locked out" — the opposite of the truth.
  if (slope >= 0) {
    return {
      fields: { ...fitted, crossesAt: null, roundsRemaining: null, projection: 'not-declining' },
      crossAtMs: null,
    };
  }
  // Declining, but nothing to decline TOWARD: these events predate the
  // thresholds being put on the wire. The trend is still real and is still
  // reported; only the crossing is withheld, and `thresholdBasis: 'absent'`
  // says why.
  if (threshold === null) {
    return {
      fields: { ...fitted, crossesAt: null, roundsRemaining: null, projection: 'no-threshold' },
      crossAtMs: null,
    };
  }

  // Rounded to the second, and the ROUNDED instant is what both the date and
  // the round count are derived from. A lockout projected to the millisecond is
  // false precision, and without this the double arithmetic renders an exact
  // midnight crossing as `...T23:59:59.999Z` — a whole day off, to a reader
  // skimming dates.
  const crossMs = Math.round((t0 + ((threshold - intercept) / slope) * DAY_MS) / 1000) * 1000;
  // `<=` rather than `<`: a crossing landing exactly on `asOf` is a lockout
  // that has arrived, not one that is upcoming. The `<` mutant is a
  // near-equivalent — it differs only on that measure-zero instant, and both
  // spellings honour "never a past date, never a negative count" — so it is
  // recorded here rather than pinned by a test of its own (review F6).
  if (crossMs <= asOfMs) {
    // The fitted line is already at or under the threshold. This is not
    // hypothetical — it is what a currently-rejecting account looks like — so
    // it gets `roundsRemaining: 0` and an explicit flag rather than a date in
    // the past or a negative count.
    //
    // THIS RUNS BEFORE THE SUPPORT BOUND AND THE ORDER IS THE BEHAVIOUR, not a
    // cheap-check-first accident to be tidied. The two conditions OVERLAP: a
    // series whose measurements stopped more than `MAX_EXTRAPOLATION x span`
    // ago can have a crossing that is both behind `asOf` and past the bound.
    // Consulting the bound first renders such an account `span-too-short` /
    // `crossedAlready: false` / `binding: null` — byte-identical to an account
    // with no lockout projected, the opposite fact, and the exact conflation
    // the binding rule below exists to remove. Pinned by the "burst that then
    // went silent" fixture; swap the two and it fails on its own.
    //
    // Why crossed outranks unsupported, given the bound is otherwise strict:
    // the bound withholds a DATE, and no date is emitted here either way —
    // `crossesAt` is null on this branch because the crossing is behind us.
    // What survives is `crossedAlready`, a claim about the sign of the fitted
    // line today, no weaker than the slope it comes from. The honest limit of
    // that, and it is the overlap case exactly: when the crossing falls after
    // the last measurement, `latestSim` is by construction still ABOVE the
    // threshold, so the flag rests on the fit alone rather than being
    // corroborated by the latest reading. `latestAt` beside it is what tells a
    // reader how stale that fit is.
    return {
      fields: {
        simSlopePerDay: slope,
        r2,
        crossesAt: null,
        roundsRemaining: 0,
        crossedAlready: true,
        projection: 'fitted',
      },
      crossAtMs: crossMs,
    };
  }
  // The support bound. Past this the line is being extended further than the
  // data it was fitted on, and the answer is withheld under its own name —
  // `not-declining` would say the opposite of what the slope says, and
  // `insufficient-points` would blame a count that may be perfectly healthy.
  if (crossMs > points[points.length - 1].t + MAX_EXTRAPOLATION * spanMs(points)) {
    return {
      fields: { ...fitted, crossesAt: null, roundsRemaining: null, projection: 'span-too-short' },
      crossAtMs: null,
    };
  }
  return {
    fields: {
      ...fitted,
      crossesAt: new Date(crossMs).toISOString(),
      roundsRemaining: Math.ceil((crossMs - asOfMs) / (ROUND_INTERVAL_HOURS * 60 * 60 * 1000)),
      projection: 'fitted',
    },
    crossAtMs: crossMs,
  };
}

/**
 * Per-account drift countdown over the uncensored measurement series.
 *
 * `asOf` is injectable so the projection has one reference instant for both
 * the window and the round arithmetic; production passes nothing and gets now.
 */
export async function getDriftCountdown(
  username: string,
  range: '7d' | '30d' | '90d' = '30d',
  asOf: Date = new Date(),
): Promise<DriftCountdownDTO> {
  const agent = await findAgentByUsername(username);
  const asOfMs = asOf.getTime();
  const since = new Date(asOfMs - RANGE_DAYS[range] * DAY_MS);

  const rows = await db
    .select({ createdAt: agentEvents.createdAt, metrics: agentEvents.metrics })
    .from(agentEvents)
    .where(
      and(
        eq(agentEvents.userId, agent.id),
        eq(agentEvents.summary, DRIFT_MEASURED_SUMMARY),
        gte(agentEvents.createdAt, since),
      ),
    )
    .orderBy(asc(agentEvents.createdAt));

  // The newest measurement is the authority on the gate's configuration: both
  // the thresholds and the mode describe the round they were recorded on, and
  // the newest round is the one a projection about the FUTURE has to assume.
  // Deliberately not "the newest event that happens to carry a threshold" — a
  // stale threshold pulled forward from an older row would be indistinguishable
  // from a current one on the wire.
  const newest = rows.length ? rows[rows.length - 1].metrics : null;
  const driftMode = newest ? readDriftMode(newest) : null;

  const crossAtMs = new Map<DriftCountdownKey, number | null>();
  const series: DriftCountdownSeriesDTO[] = SERIES_KEYS.map((key) => {
    const points: SeriesPoint[] = [];
    for (const row of rows) {
      const y = numericMetric(row.metrics, SIM_KEY[key]);
      if (y !== null) points.push({ t: row.createdAt.getTime(), y });
    }
    const threshold = newest ? numericMetric(newest, THRESHOLD_KEY[key]) : null;
    const last = points.length ? points[points.length - 1] : null;
    const fit = fitSeries(points, threshold, asOfMs);
    crossAtMs.set(key, fit.crossAtMs);
    return {
      key,
      n: points.length,
      latestSim: last ? last.y : null,
      latestAt: last ? new Date(last.t).toISOString() : null,
      thresholdSim: threshold,
      thresholdBasis: threshold === null ? 'absent' : 'event',
      // Reported whether or not anything was fitted: it is the base a reader
      // checks a projection against, so withholding it exactly when there is
      // no projection would hide why there is none.
      spanDays: points.length ? round6(spanMs(points) / DAY_MS) : null,
      ...fit.fields,
    };
  });

  // The BINDING constraint: the gating series that decides this account's fate
  // first.
  //
  // Chosen from `gating` and not from all four, because the earliest crossing
  // overall can belong to a comparison this mode does not decide with — naming
  // that one would be a lockout date for a gate that is not running. An
  // unknown mode yields no binding series at all rather than a guess, for the
  // same reason.
  //
  // ALREADY-CROSSED OUTRANKS UPCOMING. A crossed series carries `crossesAt:
  // null` (the date is behind us), and skipping nulls used to make an account
  // that is ALREADY LOCKED OUT report `binding: null` — byte-identical to an
  // account with no lockout projected, which is the opposite fact, for exactly
  // the accounts this endpoint exists to find. So: any crossed gating series
  // binds (the earliest of them, i.e. the one it has been failing longest),
  // and only if there is none does the soonest future crossing bind.
  //
  // ONE SCAN IMPLEMENTS BOTH TIERS, and the equivalence has a condition
  // (standing constraint §7). "Crossed first, then soonest future" is what
  // taking the single earliest crossing gives, because a crossed series' instant
  // is at or before `asOf` and a future one's is after it — every past crossing
  // sorts before every future crossing by construction. That holds exactly as
  // long as `crossedAlready` keeps meaning `crossAtMs <= asOfMs`; change that
  // definition and this needs the explicit two-tier sort back.
  const gating = driftMode ? GATING_SERIES[driftMode] : [];
  let binding: DriftCountdownKey | null = null;
  let bindingAt = Number.POSITIVE_INFINITY;
  for (const s of series) {
    const at = crossAtMs.get(s.key);
    // `crossAtMs`, not `s.crossesAt`: the wire field is null for a crossing
    // already behind us, so reading it here is what made an already-locked-out
    // account report `binding: null`.
    if (!gating.includes(s.key) || at === undefined || at === null) continue;
    if (at < bindingAt) {
      bindingAt = at;
      binding = s.key;
    }
  }

  return {
    username: agent.username,
    range,
    asOf: asOf.toISOString(),
    roundIntervalHours: ROUND_INTERVAL_HOURS,
    maxExtrapolation: MAX_EXTRAPOLATION,
    driftMode,
    gating,
    binding,
    series,
  };
}

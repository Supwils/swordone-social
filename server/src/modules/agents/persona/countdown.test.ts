import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../../../db/client';
import { resetDb } from '../../../test/db-reset';
import { agentEvents, users } from '../../../db/schema';
import { createApp } from '../../../app';
import { DRIFT_MEASURED_SUMMARY, getDriftCountdown } from './countdown';
import type { DriftCountdownDTO, DriftCountdownKey } from './persona.types';

/**
 * The drift countdown, against the real test Postgres.
 *
 * THE ONE THING THESE TESTS EXIST TO PREVENT: a projected lockout date fitted
 * through noise renders identically to one fitted through a real trend. So
 * every rule that stops this endpoint from lying by omission gets a test that
 * can actually fail — a non-declining slope projecting nothing, `r2` beside
 * every projection, no projection under four points, no projection reaching
 * further than the data supports, the earliest crossing among the series the
 * gate ACTUALLY enforces, and a visible fallback when the events predate the
 * thresholds being recorded.
 *
 * FIXTURE DESIGN (standing constraint §4). The four series carry four
 * different similarities, four different slopes and four different thresholds,
 * so a one-word slip between adjacent same-typed fields — `style: 'aspectTopic'`
 * in `SIM_KEY`, `topic: 'thStyle'` in `THRESHOLD_KEY` — changes a number a test
 * asserts on. A fixture where the four coincided would pass every mutation.
 *
 * AND EVERY STRAIGHT LINE HAS A NOISY COUNTERPART, which is the fix for the
 * §4 instance this file shipped with. Four collinear points make `ssTot === 0`'s
 * fallback of `1`, a hardcoded `r2 = 1`, and a WRONG r² formula that happens to
 * return 1 on an exact fit all indistinguishable — and they put `ys[0]` exactly
 * on the regression line, so the intercept is undefended too. `r2 → 1`,
 * `1 - ssRes` and `intercept → ys[0]` all survived the original suite. The two
 * `noisy` fixtures below have genuine residuals and assert `r2` to its computed
 * value, not to a range.
 *
 * THE NUMBERS ARE HAND-COMPUTED, not read off the implementation. Each straight
 * series is four points on an exact line at 2-day spacing, so the OLS slope is
 * the line's own slope and `r2` is exactly 1; the crossing is then
 * `(threshold - intercept) / slope` days after the first point, which lands on
 * a whole day in every case below. The noisy ones were solved by hand too — see
 * their own comments.
 *
 * AND ONE FIXTURE DELIBERATELY BREAKS `DAYS`, which is the §4 instance this
 * file shipped with TWICE over. Every fixture here drew its instants from
 * `DAYS = [-8,-6,-4,-2]`, so the whole suite shared two degenerate properties
 * at once: the data always stopped two days before `AS_OF` (against a support
 * bound of eighteen days or more, so no crossing could ever land between the
 * already-crossed check and the extrapolation bound — swapping those two
 * guards passed 27 of 27), and the spacing was always uniform (so the mean of
 * `xs` always equalled the midpoint of its range). "Still reports zero rounds
 * for a burst that then went silent" is the fixture that ends 22 days before
 * `AS_OF` at 1/2/3-day gaps, and it kills both. When adding a fixture here,
 * ask what property `DAYS` forces on it before reusing it.
 *
 * Service tests inject `AS_OF`; HTTP fixtures are relative to the real clock
 * because the endpoint has no reference-time parameter. These assertions stay
 * independent of the calendar date. That matters for mutation runs
 * as well as for CI: a verdict about a mutant that only differs once the wall
 * clock passes `AS_OF` is a verdict about the hour it was run in (review F9).
 */

/** The reference instant. Everything else is expressed as a day offset from it. */
const AS_OF = new Date('2026-08-20T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function at(dayOffset: number): Date {
  return new Date(AS_OF.getTime() + dayOffset * DAY_MS);
}

function atMinutes(minuteOffset: number): Date {
  return new Date(AS_OF.getTime() + minuteOffset * 60 * 1000);
}

/**
 * Four straight-line series, each with its own slope and its own threshold,
 * chosen so their crossings land on four different days.
 *
 *   series   y(-8)   slope/day   threshold   crosses      beyond last / span
 *   anchor   0.94    -0.01       0.85        AS_OF + 1d   3d / 6d = 0.5x
 *   values   0.90    -0.005      0.69        AS_OF + 34d  36d / 6d = 6.0x
 *   style    0.80    -0.02       0.52        AS_OF + 6d   8d / 6d = 1.33x
 *   topic    0.75    -0.0025     0.70        AS_OF + 12d  14d / 6d = 2.33x
 *
 * ANCHOR CROSSES FIRST ON PURPOSE. Under `DRIFT_MODE=aspect` the whole-document
 * scalar does not gate, so an implementation that took the earliest crossing of
 * all four would name `anchor` — a lockout date for a comparison nobody
 * enforces. `style` (AS_OF + 6d) is the earliest GATING crossing, and that gap
 * is what makes the distinction observable.
 *
 * AND `values` OUTRUNS ITS DATA ON PURPOSE. Its 6.0x is the only one over
 * `MAX_EXTRAPOLATION`, so this one fixture pins the bound from both sides at
 * once: raise the constant and `values` starts projecting, lower it past 2.33
 * and `topic` stops.
 */
const SIMS: Record<DriftCountdownKey, number[]> = {
  anchor: [0.94, 0.92, 0.9, 0.88],
  values: [0.9, 0.89, 0.88, 0.87],
  style: [0.8, 0.76, 0.72, 0.68],
  topic: [0.75, 0.745, 0.74, 0.735],
};
const THRESHOLDS = { thScalar: 0.85, thValues: 0.69, thStyle: 0.52, thTopic: 0.7 };
/** Day offsets of the four measurements: 2-day spacing, all inside a 30d window. */
const DAYS = [-8, -6, -4, -2];

async function seedAgent(username = 'zenith'): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      username,
      usernameDisplay: username,
      email: `${username}@example.test`,
      displayName: username,
      isAgent: true,
    })
    .returning();
  return u.id;
}

async function seedMeasurement(
  userId: string,
  createdAt: Date,
  metrics: Record<string, unknown>,
): Promise<void> {
  await db.insert(agentEvents).values({
    userId,
    type: 'dream',
    phase: 'dream',
    outcome: 'success',
    summary: 'drift measured',
    metrics,
    createdAt,
  });
}

/** One scalar-mode series: `sims[i]` measured at `whens[i]`, against `threshold`. */
async function seedScalarSeries(
  userId: string,
  whens: Date[],
  sims: number[],
  threshold: number,
): Promise<void> {
  for (let i = 0; i < whens.length; i += 1) {
    await seedMeasurement(userId, whens[i], {
      anchorSim: sims[i],
      driftMode: 'scalar',
      thScalar: threshold,
    });
  }
}

/** The four-point, four-series fixture described above. */
async function seedStraightLines(
  userId: string,
  over: { driftMode?: string; thresholds?: Record<string, number> | null; asOf?: Date } = {},
): Promise<void> {
  const thresholds = over.thresholds === undefined ? THRESHOLDS : over.thresholds;
  const reference = over.asOf ?? AS_OF;
  for (let i = 0; i < DAYS.length; i += 1) {
    await seedMeasurement(userId, new Date(reference.getTime() + DAYS[i] * DAY_MS), {
      anchorSim: SIMS.anchor[i],
      stepSim: 0.5,
      aspectValues: SIMS.values[i],
      aspectStyle: SIMS.style[i],
      aspectTopic: SIMS.topic[i],
      embedderOk: true,
      driftMode: over.driftMode ?? 'aspect',
      ...(thresholds ?? {}),
    });
  }
}

function seriesOf(out: DriftCountdownDTO, key: DriftCountdownKey) {
  const s = out.series.find((x) => x.key === key);
  if (!s) throw new Error(`no series ${key}`);
  return s;
}

describe('countdown.getDriftCountdown', () => {
  beforeEach(resetDb);

  it('fits each series, projects its crossing, and refuses the one that outruns its data', async () => {
    const userId = await seedAgent();
    await seedStraightLines(userId);

    const out = await getDriftCountdown('zenith', '30d', AS_OF);

    expect(out.username).toBe('zenith');
    expect(out.range).toBe('30d');
    expect(out.asOf).toBe(AS_OF.toISOString());
    expect(out.roundIntervalHours).toBe(48);
    expect(out.maxExtrapolation).toBe(3);
    expect(out.driftMode).toBe('aspect');

    // Every number below is the hand-computed value for THAT series. Four
    // different slopes, four different thresholds, four different crossings —
    // so mis-mapping any metrics key to a neighbouring one moves at least one
    // of these.
    expect(seriesOf(out, 'anchor')).toEqual({
      key: 'anchor',
      n: 4,
      latestSim: 0.88,
      latestAt: at(-2).toISOString(),
      thresholdSim: 0.85,
      thresholdBasis: 'event',
      spanDays: 6,
      simSlopePerDay: -0.01,
      r2: 1,
      crossesAt: at(1).toISOString(),
      roundsRemaining: 1,
      crossedAlready: false,
      projection: 'fitted',
    });
    // 6 days of data, a crossing 36 days past the last of them: 6x its own
    // span. The trend, the fit quality and the span are all still reported —
    // only the date is withheld, under its own name.
    expect(seriesOf(out, 'values')).toEqual({
      key: 'values',
      n: 4,
      latestSim: 0.87,
      latestAt: at(-2).toISOString(),
      thresholdSim: 0.69,
      thresholdBasis: 'event',
      spanDays: 6,
      simSlopePerDay: -0.005,
      r2: 1,
      crossesAt: null,
      roundsRemaining: null,
      crossedAlready: false,
      projection: 'span-too-short',
    });
    expect(seriesOf(out, 'style')).toEqual({
      key: 'style',
      n: 4,
      latestSim: 0.68,
      latestAt: at(-2).toISOString(),
      thresholdSim: 0.52,
      thresholdBasis: 'event',
      spanDays: 6,
      simSlopePerDay: -0.02,
      r2: 1,
      crossesAt: at(6).toISOString(),
      roundsRemaining: 3,
      crossedAlready: false,
      projection: 'fitted',
    });
    expect(seriesOf(out, 'topic')).toEqual({
      key: 'topic',
      n: 4,
      latestSim: 0.735,
      latestAt: at(-2).toISOString(),
      thresholdSim: 0.7,
      thresholdBasis: 'event',
      spanDays: 6,
      simSlopePerDay: -0.0025,
      r2: 1,
      crossesAt: at(12).toISOString(),
      roundsRemaining: 6,
      crossedAlready: false,
      projection: 'fitted',
    });
  });

  it('reports r2 BELOW one for a series with real residuals, and the date that fit gives', async () => {
    // The fixture the original suite lacked. `[0.90, 0.70, 0.85, 0.60]` at
    // 2-day spacing is not a line: xs are [0,2,4,6], ybar 0.7625, Sxx 20,
    // Sxy -0.75, so slope -0.0375 and intercept 0.875. SSres 0.0455, SStot
    // 0.090075 → r2 = 1 - 0.504.. = 0.494505 (6dp). The crossing to 0.30 is
    // (0.30 - 0.875) / -0.0375 = 15.333.. days after day -8, i.e.
    // AS_OF + 7d 8h, and ceil(7.333d / 2d) = 4 rounds.
    //
    // WHAT THIS DEFENDS, and nothing else in the file does: `r2` computed as
    // anything other than `1 - ssRes/ssTot` (a constant `1`, or `1 - ssRes`,
    // both of which are right on every exact line), and `intercept` taken as
    // `ys[0]` (0.90 here, not 0.875 — which moves the date to AS_OF + 8d).
    const userId = await seedAgent();
    await seedScalarSeries(userId, DAYS.map(at), [0.9, 0.7, 0.85, 0.6], 0.3);

    const anchor = seriesOf(await getDriftCountdown('zenith', '30d', AS_OF), 'anchor');

    expect(anchor.simSlopePerDay).toBe(-0.0375);
    expect(anchor.r2).toBe(0.494505);
    expect(anchor.projection).toBe('fitted');
    expect(anchor.crossesAt).toBe('2026-08-27T08:00:00.000Z');
    expect(anchor.roundsRemaining).toBe(4);
    expect(anchor.spanDays).toBe(6);
  });

  it('reports a noisy fit that has already crossed with its real r2, not with 1', async () => {
    // A second residual-bearing fixture, on the already-crossed branch: one
    // wild reading (0.10) in an otherwise flat-ish series. xs [0,2,4,6],
    // ybar 0.71, Sxx 20, Sxy -1.0 → slope -0.05, intercept 0.86. SSres
    // 0.3116, SStot 0.3464 → r2 = 0.100402. The crossing to 0.85 is 0.2 days
    // after day -8: long behind us.
    const userId = await seedAgent();
    await seedScalarSeries(userId, DAYS.map(at), [0.94, 0.92, 0.1, 0.88], 0.85);

    const out = await getDriftCountdown('zenith', '30d', AS_OF);
    const anchor = seriesOf(out, 'anchor');

    expect(anchor.simSlopePerDay).toBe(-0.05);
    expect(anchor.r2).toBe(0.100402);
    expect(anchor.crossedAlready).toBe(true);
    expect(anchor.roundsRemaining).toBe(0);
    expect(anchor.crossesAt).toBeNull();
    // Already locked out is a lockout: the account's binding constraint is
    // this series, not "nothing".
    expect(out.binding).toBe('anchor');
  });

  it('refuses to project months out of an hour of measurements, r2 of 1 notwithstanding', async () => {
    // THE BURST. Four gate events twenty minutes apart — `FORCE_DREAM=1`, a
    // hand-run `swil-agent dream`, a debugging retry loop, a backfill — sliding
    // 0.900 → 0.897 against a 0.82 threshold. The real trend behind those
    // numbers is ~77 more gate attempts, i.e. months.
    //
    // Before the bound this returned, from the real service: slopePerDay
    // -0.072, r2 1, crossesAt 2026-08-21T01:40:00.000Z, roundsRemaining 1.
    // Every one of those is arithmetically correct and the conclusion is two
    // orders of magnitude wrong — and `r2: 1` made it look MORE trustworthy,
    // because r² scores the fit, not the sampling.
    const userId = await seedAgent();
    await seedScalarSeries(
      userId,
      [-60, -40, -20, 0].map(atMinutes),
      [0.9, 0.899, 0.898, 0.897],
      0.82,
    );

    const out = await getDriftCountdown('zenith', '30d', AS_OF);
    const anchor = seriesOf(out, 'anchor');

    expect(anchor.n).toBe(4);
    expect(anchor.spanDays).toBe(0.041667); // one hour
    expect(anchor.simSlopePerDay).toBe(-0.072);
    expect(anchor.r2).toBe(1);
    expect(anchor.projection).toBe('span-too-short');
    expect(anchor.crossesAt).toBeNull();
    expect(anchor.roundsRemaining).toBeNull();
    // Not "already locked out" either — the refusal is about the future.
    expect(anchor.crossedAlready).toBe(false);
    // A refused crossing must not bind: naming it would put the account's
    // headline on a date the series itself declines to report.
    expect(out.binding).toBeNull();
  });

  it('places the extrapolation bound at 3x the span, projecting just under and refusing just over', async () => {
    // Two series over the SAME four instants with the SAME slope, differing
    // only in threshold, so the ratio is the only thing that decides:
    //
    //   anchor  th 0.785 → crossing 17d past the last point = 2.83x  → fitted
    //   style   th 0.775 → crossing 19d past the last point = 3.17x  → refused
    //
    // That brackets `MAX_EXTRAPOLATION` from both sides: at 2 the anchor stops
    // projecting, at 4 the style series starts. A one-sided fixture would let
    // any constant in a wide band pass.
    //
    // AND THE MEASUREMENTS STOP TWO DAYS BEFORE `AS_OF`, which is the other
    // thing this fixture pins: the horizon is measured from the last
    // MEASUREMENT, not from `asOf`. Those differ by exactly the 2-day gap, and
    // the style series sits inside it — 19d past the last point, but only 17d
    // past `asOf`, so a bound applied from `asOf` would let it through.
    const userId = await seedAgent();
    const whens = DAYS.map(at);
    const line = [0.9, 0.89, 0.88, 0.87];
    for (let i = 0; i < whens.length; i += 1) {
      await seedMeasurement(userId, whens[i], {
        anchorSim: line[i],
        aspectStyle: line[i],
        driftMode: 'scalar',
        thScalar: 0.785,
        thStyle: 0.775,
      });
    }

    const out = await getDriftCountdown('zenith', '30d', AS_OF);
    const anchor = seriesOf(out, 'anchor');
    const style = seriesOf(out, 'style');

    expect(anchor.spanDays).toBe(6);
    expect(style.spanDays).toBe(6);
    expect(anchor.simSlopePerDay).toBe(-0.005);
    expect(style.simSlopePerDay).toBe(-0.005);

    expect(anchor.projection).toBe('fitted');
    expect(anchor.crossesAt).toBe(at(15).toISOString());
    expect(anchor.roundsRemaining).toBe(8);

    expect(style.projection).toBe('span-too-short');
    expect(style.crossesAt).toBeNull();
    expect(style.roundsRemaining).toBeNull();
  });

  it('binds the earliest GATING crossing, not the earliest crossing', async () => {
    const userId = await seedAgent();
    await seedStraightLines(userId);

    const out = await getDriftCountdown('zenith', '30d', AS_OF);

    // The precondition that makes this test non-vacuous: the anchor really
    // does cross first, so "earliest of all four" and "earliest of the gating
    // three" are different answers here.
    const anchor = seriesOf(out, 'anchor');
    const style = seriesOf(out, 'style');
    expect(Date.parse(anchor.crossesAt as string)).toBeLessThan(
      Date.parse(style.crossesAt as string),
    );

    expect(out.gating).toEqual(['values', 'style', 'topic']);
    expect(out.binding).toBe('style');
  });

  it('binds a series that has ALREADY crossed over one that is merely going to', async () => {
    // The panel this feeds renders one sentence off `binding`. An account
    // already locked out on `values` and heading for `style` in six days must
    // not render as "style, in 6 days" — and before this rule it rendered as
    // `binding: null`, i.e. "no lockout projected", which is the opposite of
    // the truth for exactly the accounts the endpoint exists to find.
    //
    // Three gating series, all three distinguishable:
    //   values  0.80→0.68, th 0.75 → crossed at AS_OF - 5.5d  (earliest crossed)
    //   topic   0.80→0.68, th 0.70 → crossed at AS_OF - 3d    (later crossed)
    //   style   0.80→0.68, th 0.52 → crosses at AS_OF + 6d    (soonest future)
    const userId = await seedAgent();
    const line = [0.8, 0.76, 0.72, 0.68];
    for (let i = 0; i < DAYS.length; i += 1) {
      await seedMeasurement(userId, at(DAYS[i]), {
        aspectValues: line[i],
        aspectStyle: line[i],
        aspectTopic: line[i],
        driftMode: 'aspect',
        thValues: 0.75,
        thStyle: 0.52,
        thTopic: 0.7,
      });
    }

    const out = await getDriftCountdown('zenith', '30d', AS_OF);

    // Preconditions, so this cannot pass vacuously: there IS a future crossing
    // to prefer wrongly, and there are TWO crossed series to order.
    expect(seriesOf(out, 'style').crossesAt).toBe(at(6).toISOString());
    expect(seriesOf(out, 'values').crossedAlready).toBe(true);
    expect(seriesOf(out, 'topic').crossedAlready).toBe(true);

    // `values` crossed 5.5 days ago, `topic` 3 days ago: the earliest of the
    // crossed ones, i.e. the constraint it has been failing longest.
    expect(out.binding).toBe('values');
  });

  it('binds the scalar series in scalar mode, on the very same measurements', async () => {
    // Same numbers as the gating test above; only the recorded DRIFT_MODE
    // differs. So this pins that `gating` is read out of the data rather than
    // fixed to the aspect trio — a hardcoded `['values','style','topic']`
    // answers 'style' here and fails.
    const userId = await seedAgent();
    await seedStraightLines(userId, { driftMode: 'scalar' });

    const out = await getDriftCountdown('zenith', '30d', AS_OF);

    expect(out.driftMode).toBe('scalar');
    expect(out.gating).toEqual(['anchor']);
    expect(out.binding).toBe('anchor');
  });

  it('names no binding series when the recorded mode is unknown', async () => {
    // A guess here would be a lockout date attributed to a gate we cannot show
    // is running. The per-series projections are still there; only the claim
    // about which one BINDS is withheld.
    const userId = await seedAgent();
    await seedStraightLines(userId, { driftMode: 'sideways' });

    const out = await getDriftCountdown('zenith', '30d', AS_OF);

    expect(out.driftMode).toBeNull();
    expect(out.gating).toEqual([]);
    expect(out.binding).toBeNull();
    expect(seriesOf(out, 'style').crossesAt).toBe(at(6).toISOString());
  });

  it('takes the threshold and the mode from the NEWEST measurement', async () => {
    // The four original rows say `aspect` / thScalar 0.85; a fifth, newer row
    // says `scalar` / 0.40. Both values are distinguishable from the older
    // ones and from every real default, so "first row", "any row" and "newest
    // row" give three different answers.
    const userId = await seedAgent();
    await seedStraightLines(userId);
    await seedMeasurement(userId, at(0), {
      anchorSim: 0.86,
      aspectValues: 0.86,
      aspectStyle: 0.6,
      aspectTopic: 0.73,
      driftMode: 'scalar',
      thScalar: 0.4,
      thValues: 0.41,
      thStyle: 0.42,
      thTopic: 0.43,
    });

    const out = await getDriftCountdown('zenith', '30d', AS_OF);

    expect(out.driftMode).toBe('scalar');
    expect(seriesOf(out, 'anchor').thresholdSim).toBe(0.4);
    expect(seriesOf(out, 'values').thresholdSim).toBe(0.41);
    expect(seriesOf(out, 'style').thresholdSim).toBe(0.42);
    expect(seriesOf(out, 'topic').thresholdSim).toBe(0.43);
    expect(seriesOf(out, 'anchor').n).toBe(5);
  });

  it('projects nothing from a rising trend, and still reports the trend', async () => {
    const userId = await seedAgent();
    for (let i = 0; i < DAYS.length; i += 1) {
      await seedMeasurement(userId, at(DAYS[i]), {
        anchorSim: 0.7 + i * 0.02,
        driftMode: 'scalar',
        thScalar: 0.6,
      });
    }

    const out = await getDriftCountdown('zenith', '30d', AS_OF);
    const anchor = seriesOf(out, 'anchor');

    // Solving for the crossing anyway puts it in the PAST (the line is moving
    // away from the threshold), and a past date reads as "already locked out"
    // — the exact opposite of what the data says.
    expect(anchor.projection).toBe('not-declining');
    expect(anchor.crossesAt).toBeNull();
    expect(anchor.roundsRemaining).toBeNull();
    expect(anchor.crossedAlready).toBe(false);
    // The measured trend is still reported: this account is moving, upward.
    expect(anchor.simSlopePerDay).toBe(0.01);
    expect(anchor.r2).toBe(1);
    expect(out.binding).toBeNull();
  });

  it('treats an exactly flat series as non-declining rather than crossing instantly', async () => {
    // The `>= 0` boundary. With `> 0` a flat series divides by zero, lands a
    // crossing at -Infinity, and reports the account as already locked out.
    const userId = await seedAgent();
    await seedScalarSeries(userId, DAYS.map(at), [0.75, 0.75, 0.75, 0.75], 0.6);

    const out = await getDriftCountdown('zenith', '30d', AS_OF);
    const anchor = seriesOf(out, 'anchor');

    expect(anchor.projection).toBe('not-declining');
    expect(anchor.simSlopePerDay).toBe(0);
    // No variance to explain, and the line explains it exactly.
    expect(anchor.r2).toBe(1);
    expect(anchor.crossesAt).toBeNull();
    expect(anchor.crossedAlready).toBe(false);
  });

  it('refuses to fit three points, and fits the fourth the moment it lands', async () => {
    // Both halves of the `n < 4` boundary, on the same declining line: a
    // threshold of 3 fits the first call, a threshold of 5 fails the second.
    const userId = await seedAgent();
    const line = [0.94, 0.92, 0.9, 0.88];
    await seedScalarSeries(userId, DAYS.slice(0, 3).map(at), line.slice(0, 3), 0.85);

    const three = seriesOf(await getDriftCountdown('zenith', '30d', AS_OF), 'anchor');
    expect(three.projection).toBe('insufficient-points');
    expect(three.n).toBe(3);
    // The raw points survive — only the projection is withheld. `spanDays`
    // among them: it describes the data, not the fit, so it ships even where
    // nothing was fitted.
    expect(three.latestSim).toBe(0.9);
    expect(three.latestAt).toBe(at(-4).toISOString());
    expect(three.thresholdSim).toBe(0.85);
    expect(three.spanDays).toBe(4);
    expect(three.simSlopePerDay).toBeNull();
    expect(three.r2).toBeNull();
    expect(three.crossesAt).toBeNull();
    expect(three.roundsRemaining).toBeNull();

    await seedMeasurement(userId, at(DAYS[3]), {
      anchorSim: line[3],
      driftMode: 'scalar',
      thScalar: 0.85,
    });

    const four = seriesOf(await getDriftCountdown('zenith', '30d', AS_OF), 'anchor');
    expect(four.projection).toBe('fitted');
    expect(four.n).toBe(4);
    expect(four.spanDays).toBe(6);
    expect(four.simSlopePerDay).toBe(-0.01);
    expect(four.crossesAt).toBe(at(1).toISOString());
  });

  it('refuses to fit points that all share one timestamp', async () => {
    // A vertical "fit" has a zero denominator: without the guard the slope is
    // NaN or ±Infinity, and NaN >= 0 is false, so it would sail past the
    // not-declining check into a nonsense crossing.
    const userId = await seedAgent();
    await seedScalarSeries(userId, [at(-3), at(-3), at(-3), at(-3)], [0.94, 0.92, 0.9, 0.88], 0.8);

    const anchor = seriesOf(await getDriftCountdown('zenith', '30d', AS_OF), 'anchor');

    expect(anchor.n).toBe(4);
    expect(anchor.projection).toBe('no-time-span');
    // Zero, not null: there are readings, they just cover no time at all —
    // which is the number that explains the refusal.
    expect(anchor.spanDays).toBe(0);
    expect(anchor.simSlopePerDay).toBeNull();
    expect(anchor.r2).toBeNull();
    expect(anchor.crossesAt).toBeNull();
  });

  it('says so, rather than substituting a default, when the events carry no threshold', async () => {
    // Every `drift measured` event before 2026-08-20 is shaped like this. The
    // one thing this endpoint must never do here is reach for the deployed
    // 0.82/0.63/0.72/0.71 — a fourth copy of numbers that can be retuned would
    // silently reinterpret every historical point.
    const userId = await seedAgent();
    await seedStraightLines(userId, { thresholds: null });

    const out = await getDriftCountdown('zenith', '30d', AS_OF);

    for (const s of out.series) {
      expect(s.thresholdSim).toBeNull();
      expect(s.thresholdBasis).toBe('absent');
      expect(s.crossesAt).toBeNull();
      expect(s.roundsRemaining).toBeNull();
      expect(s.projection).toBe('no-threshold');
    }
    // The trend itself is real data and is still reported — only the crossing
    // needs a threshold.
    expect(seriesOf(out, 'anchor').simSlopePerDay).toBe(-0.01);
    expect(seriesOf(out, 'style').simSlopePerDay).toBe(-0.02);
    expect(seriesOf(out, 'anchor').r2).toBe(1);
    expect(seriesOf(out, 'anchor').spanDays).toBe(6);
    expect(out.binding).toBeNull();
  });

  it('reports a crossing already behind us as zero rounds, never a negative count', async () => {
    // What a currently-rejecting account looks like, so this branch is the
    // common case rather than an edge one.
    const userId = await seedAgent();
    await seedScalarSeries(userId, DAYS.map(at), [0.8, 0.76, 0.72, 0.68], 0.75);

    const out = await getDriftCountdown('zenith', '30d', AS_OF);
    const anchor = seriesOf(out, 'anchor');

    expect(anchor.simSlopePerDay).toBe(-0.02);
    expect(anchor.crossedAlready).toBe(true);
    expect(anchor.roundsRemaining).toBe(0);
    expect(anchor.crossesAt).toBeNull();
    expect(anchor.projection).toBe('fitted');
    // And it still BINDS. "Already locked out" and "no lockout projected" are
    // opposite facts; rendering both as `binding: null` would have put the
    // wrong sentence on exactly the accounts that matter.
    expect(out.binding).toBe('anchor');
  });

  it('still reports zero rounds when the line was under the threshold before the window opened', async () => {
    // The other shape of "already crossed", and the more common one: an
    // account that has been failing the gate for weeks has EVERY reading in
    // the window below its threshold, so the fitted crossing lands before the
    // first measurement rather than between two of them. 0.60 → 0.54 against a
    // threshold of 0.75 crosses at AS_OF - 23d, fifteen days before the oldest
    // point.
    //
    // Found by mutation: qualifying the already-crossed branch with "and the
    // crossing is not before the first point" left the whole suite green,
    // because every crossed fixture here crossed INSIDE its window. Such a
    // series would then fall through to the ordinary path and ship
    // `crossesAt: 2026-07-28` with `roundsRemaining: -11` — a past date and a
    // negative count, the two things this endpoint promises never to emit.
    const userId = await seedAgent();
    await seedScalarSeries(userId, DAYS.map(at), [0.6, 0.58, 0.56, 0.54], 0.75);

    const out = await getDriftCountdown('zenith', '30d', AS_OF);
    const anchor = seriesOf(out, 'anchor');

    expect(anchor.simSlopePerDay).toBe(-0.01);
    expect(anchor.latestSim).toBe(0.54);
    // Precondition: the fitted crossing really is before the oldest reading.
    expect(anchor.latestSim).toBeLessThan(anchor.thresholdSim as number);
    expect(anchor.crossedAlready).toBe(true);
    expect(anchor.crossesAt).toBeNull();
    expect(anchor.roundsRemaining).toBe(0);
    expect(anchor.projection).toBe('fitted');
    expect(out.binding).toBe('anchor');
  });

  it('still reports zero rounds for a burst that then went silent longer than its own span', async () => {
    // THE ORDER OF THE TWO GUARDS, pinned. `crossMs <= asOf` (already locked
    // out) and `crossMs > lastT + 3 x span` (extrapolated further than the data
    // supports) are both comparisons against the same crossing, and every OTHER
    // fixture in this file makes them agree — because every other fixture's
    // measurements stop two days before `AS_OF` while `3 x span` is eighteen
    // days or more, so no crossing can land between the two. Here one does:
    //
    //   four attempts over 6 days, day -28 .. day -22, then 22 days of silence
    //   0.90 -> 0.84 at -0.01/day against a threshold of 0.65
    //   fitted crossing 25 days after the first point  =  AS_OF - 3d
    //   support bound   day -22 + 3 x 6d               =  AS_OF - 4d
    //
    // so the crossing is BEHIND `asOf` and BEYOND the support bound at once,
    // and whichever guard is consulted first decides the answer. Consulting the
    // bound first — what any "hoist the cheap check above the expensive branch"
    // refactor produces — turns this account from `fitted / crossedAlready:
    // true / 0 rounds / binding: anchor` into `span-too-short / false / null /
    // binding: null`, which is byte-for-byte how an account with NO lockout
    // projected renders. That is the exact conflation the binding rule in
    // `persona/countdown.ts` exists to remove, and it passed all 27 tests in
    // this file before this one was written.
    //
    // The shape is ordinary, not exotic: two of the 23 accounts filed no
    // measurement at all in the round of 2026-08-20, and eight have been
    // personality-frozen for a week or more. A stale tail is the norm here.
    //
    // AND THE GAPS ARE 1/2/3 DAYS, NOT 2/2/2, which closes a second shared
    // degeneracy: every other multi-point fixture is evenly spaced, and even
    // spacing makes the mean of `xs` equal the midpoint of its range — so
    // `xBar` computed as `(xs[0] + xs[n - 1]) / 2` fitted all of them
    // identically. It does not fit this one (mean 2.5 vs midpoint 3, slope
    // -0.01 vs -0.009545, r2 1 vs 0.954545). Real gate attempts are not evenly
    // spaced either; the module header says so.
    const userId = await seedAgent();
    await seedScalarSeries(userId, [-28, -27, -25, -22].map(at), [0.9, 0.89, 0.87, 0.84], 0.65);

    const out = await getDriftCountdown('zenith', '30d', AS_OF);
    const anchor = seriesOf(out, 'anchor');

    expect(anchor.n).toBe(4);
    expect(anchor.spanDays).toBe(6);
    expect(anchor.simSlopePerDay).toBe(-0.01);
    expect(anchor.r2).toBe(1);
    expect(anchor.latestSim).toBe(0.84);
    expect(anchor.latestAt).toBe(at(-22).toISOString());
    // The precondition that makes this the only fixture that can SEE the
    // ordering, asserted off the wire rather than restated as a literal so it
    // cannot quietly stop holding: the silence after the last reading is longer
    // than the support bound itself. 22 days against 3 x 6 = 18, so it survives
    // `MAX_EXTRAPOLATION` up to 3.67 and this line fails above that — which is
    // the point. A raised constant does not break the code, it stops these
    // instants from straddling the two guards, and the fixture must then move
    // further back rather than be quietly relaxed.
    const silentDays = (AS_OF.getTime() - Date.parse(anchor.latestAt as string)) / DAY_MS;
    expect(silentDays).toBeGreaterThan(out.maxExtrapolation * (anchor.spanDays as number));

    expect(anchor.projection).toBe('fitted');
    expect(anchor.crossedAlready).toBe(true);
    expect(anchor.roundsRemaining).toBe(0);
    expect(anchor.crossesAt).toBeNull();
    expect(out.binding).toBe('anchor');
  });

  it('bounds the fit by the range, so an old point does not bend a recent trend', async () => {
    // All three ranges are exercised against one seeding, so the day count
    // behind each of them is pinned: the fixture spans day -8 to -2 and there
    // is a fifth reading at day -40.
    const userId = await seedAgent();
    await seedStraightLines(userId, { driftMode: 'scalar' });
    await seedMeasurement(userId, at(-40), {
      anchorSim: 0.99,
      driftMode: 'scalar',
      thScalar: 0.85,
    });

    // 7d reaches back to day -7, clipping the oldest of the four.
    const week = seriesOf(await getDriftCountdown('zenith', '7d', AS_OF), 'anchor');
    expect(week.n).toBe(3);
    expect(week.spanDays).toBe(4);

    // 30d holds the four and nothing else.
    const month = seriesOf(await getDriftCountdown('zenith', '30d', AS_OF), 'anchor');
    expect(month.n).toBe(4);
    expect(month.spanDays).toBe(6);
    expect(month.simSlopePerDay).toBe(-0.01);

    // 90d additionally holds the day -40 reading, which is much higher and so
    // flattens the fit — the point of bounding the window at all.
    const quarter = seriesOf(await getDriftCountdown('zenith', '90d', AS_OF), 'anchor');
    expect(quarter.n).toBe(5);
    expect(quarter.spanDays).toBe(38);
    expect(quarter.simSlopePerDay).not.toBe(-0.01);
    expect(quarter.simSlopePerDay).toBeLessThan(0);
    expect(quarter.simSlopePerDay).toBeGreaterThan(-0.01);
  });

  it('reads only this account, and only its drift measurements', async () => {
    const userId = await seedAgent();
    const otherId = await seedAgent('mirror');
    await seedStraightLines(userId, { driftMode: 'scalar' });

    // Another account's measurements, at the same instants and wildly
    // different values.
    await seedScalarSeries(otherId, DAYS.map(at), [0.1, 0.1, 0.1, 0.1], 0.05);
    // This account's OTHER events, one of which carries an anchorSim under a
    // different summary — the act path's self-similarity sampler is a real
    // event that lives in the same table.
    await db.insert(agentEvents).values({
      userId,
      type: 'cycle',
      phase: 'act',
      outcome: 'success',
      summary: 'act self-similarity measured',
      metrics: { anchorSim: 0.05, maxSim: 0.9, driftMode: 'scalar', thScalar: 0.01 },
      createdAt: at(-1),
    });

    const out = await getDriftCountdown('zenith', '30d', AS_OF);
    const anchor = seriesOf(out, 'anchor');

    expect(anchor.n).toBe(4);
    expect(anchor.latestSim).toBe(0.88);
    expect(anchor.thresholdSim).toBe(0.85);
    expect(anchor.simSlopePerDay).toBe(-0.01);
  });

  it('leaves a series empty when the measurements carry no value for it', async () => {
    // Scalar-mode rounds record `aspectValues: null` — "not computed", which is
    // a different fact from a similarity of 0 and must not be fitted as one.
    const userId = await seedAgent();
    const line = [0.94, 0.92, 0.9, 0.88];
    for (let i = 0; i < DAYS.length; i += 1) {
      await seedMeasurement(userId, at(DAYS[i]), {
        anchorSim: line[i],
        aspectValues: null,
        aspectStyle: null,
        aspectTopic: null,
        driftMode: 'scalar',
        thScalar: 0.85,
        thValues: 0.63,
      });
    }

    const out = await getDriftCountdown('zenith', '30d', AS_OF);

    expect(seriesOf(out, 'anchor').n).toBe(4);
    for (const key of ['values', 'style', 'topic'] as DriftCountdownKey[]) {
      const s = seriesOf(out, key);
      expect(s.n).toBe(0);
      expect(s.latestSim).toBeNull();
      expect(s.latestAt).toBeNull();
      // No readings at all is a different fact from readings covering no time.
      expect(s.spanDays).toBeNull();
      expect(s.projection).toBe('insufficient-points');
      expect(s.simSlopePerDay).toBeNull();
    }
    // The threshold is still reported for an empty series: it was in force,
    // there was just nothing to compare against it.
    expect(seriesOf(out, 'values').thresholdSim).toBe(0.63);
  });

  it('returns an empty, honest answer for an account with no measurements', async () => {
    await seedAgent();

    const out = await getDriftCountdown('zenith', '30d', AS_OF);

    expect(out.driftMode).toBeNull();
    expect(out.gating).toEqual([]);
    expect(out.binding).toBeNull();
    expect(out.series).toHaveLength(4);
    for (const s of out.series) {
      expect(s.n).toBe(0);
      expect(s.thresholdSim).toBeNull();
      expect(s.thresholdBasis).toBe('absent');
      expect(s.spanDays).toBeNull();
      expect(s.projection).toBe('insufficient-points');
    }
  });

  it('echoes the canonical username, not the spelling it was asked with', async () => {
    // `usernameParam` accepts `[a-zA-Z0-9_]`, so a mixed-case path segment
    // reaches here and `findAgentByUsername` lowercases it for the lookup. The
    // account it FOUND is what must come back on the wire — echoing the request
    // would hand a client a username that does not match the one every other
    // lab read reports for the same row.
    //
    // The behaviour is already correct; what was missing is the defence.
    // Returning the request's spelling verbatim survived the whole 45-file
    // server suite (task-4 review, F4), so this pins a property nothing was
    // holding rather than fixing a live defect.
    await seedAgent();

    const out = await getDriftCountdown('ZeNiTh', '30d', AS_OF);

    expect(out.username).toBe('zenith');
  });

  it('404s an account that does not exist', async () => {
    await expect(getDriftCountdown('nobody', '30d', AS_OF)).rejects.toMatchObject({ status: 404 });
  });
});

describe('the drift-measured summary is frozen history', () => {
  /**
   * The query narrows on `summary = 'drift measured'`, the string the Era 1/2
   * drift gate filed its calibration event under. Era 3 (2026-10-14) removed
   * the gate, so no producer remains and the rows that exist are all the rows
   * there will be. Rewording the constant would make the countdown report
   * `n: 0` for every account, which reads like "no rounds yet".
   */
  it('keeps the literal the historical rows were written with', () => {
    expect(DRIFT_MEASURED_SUMMARY).toBe('drift measured');
  });
});

describe('GET /agents/:username/drift-countdown', () => {
  beforeEach(resetDb);

  it('serves the projection publicly, like every other lab read', async () => {
    const userId = await seedAgent();
    // The HTTP handler uses today's window, so keep its measurements recent.
    await seedStraightLines(userId, { asOf: new Date() });

    const res = await request(createApp()).get('/api/v1/agents/zenith/drift-countdown?range=30d');

    expect(res.status).toBe(200);
    expect(res.body.data.range).toBe('30d');
    expect(res.body.data.driftMode).toBe('aspect');
    expect(res.body.data.binding).toBe('style');
    const style = (res.body.data as DriftCountdownDTO).series.find((s) => s.key === 'style');
    expect(style?.thresholdSim).toBe(0.52);
    expect(style?.r2).toBe(1);
    expect(style?.spanDays).toBe(6);
  });

  it('honours the requested range rather than the default', async () => {
    // Found by mutation: the HTTP tests originally asked for `range=30d`, which
    // is ALSO the controller's default — so a controller that ignored the query
    // string entirely passed every one of them. Standing constraint §2: for
    // wiring code the ARGUMENT is the behaviour.
    //
    // Seeded relative to the REAL clock, not to `AS_OF`: the HTTP path has no
    // `asOf` to inject, so a fixture pinned to a fixed date would answer
    // differently every day and be green today for the wrong reason. Three
    // ranges, three different counts, none of them equal to another.
    const userId = await seedAgent();
    for (const days of [1, 2, 3, 4, 20, 40]) {
      await seedMeasurement(userId, new Date(Date.now() - days * DAY_MS), {
        anchorSim: 0.9 - days * 0.001,
        driftMode: 'scalar',
        thScalar: 0.85,
      });
    }

    const anchorN = async (query: string): Promise<number | undefined> => {
      const res = await request(createApp()).get(`/api/v1/agents/zenith/drift-countdown${query}`);
      expect(res.status).toBe(200);
      return (res.body.data as DriftCountdownDTO).series.find((s) => s.key === 'anchor')?.n;
    };

    expect(await anchorN('?range=7d')).toBe(4);
    expect(await anchorN('?range=30d')).toBe(5);
    expect(await anchorN('?range=90d')).toBe(6);
    // No range at all is the 30d default — asserted so the three above cannot
    // be read as "any range works".
    expect(await anchorN('')).toBe(5);
  });

  it('projects from the instant of the request, not from a frozen one', async () => {
    // Standing constraint §4, the sibling of the same hole in
    // `persona/collapse.test.ts`. `asOf` is injectable and every service test
    // above injects `AS_OF` — but the HTTP path passes nothing and takes the
    // `= new Date()` default, which no test reached. The HTTP tests around this
    // one seed relative to `Date.now()` and assert COUNTS inside windows of
    // seven days and more, so replacing that default with a date a day out left
    // the entire 45-file server suite green: the fixture drew its instants from
    // the same clock the code read.
    //
    // `asOf` ships on the wire, so the pin is the instant itself, bracketed by
    // two reads of the real clock either side of the request — milliseconds
    // wide, so any frozen date fails it.
    await seedAgent();

    const before = Date.now();
    const res = await request(createApp()).get('/api/v1/agents/zenith/drift-countdown?range=7d');
    const after = Date.now();

    expect(res.status).toBe(200);
    const asOf = Date.parse((res.body.data as DriftCountdownDTO).asOf);
    expect(asOf).toBeGreaterThanOrEqual(before);
    expect(asOf).toBeLessThanOrEqual(after);
  });

  it('rejects a range it cannot bound the query with', async () => {
    const userId = await seedAgent();
    await seedStraightLines(userId);

    const res = await request(createApp()).get('/api/v1/agents/zenith/drift-countdown?range=5y');

    expect(res.status).toBe(400);
  });

  it('404s an unknown account', async () => {
    const res = await request(createApp()).get('/api/v1/agents/nobody/drift-countdown');

    expect(res.status).toBe(404);
  });
});

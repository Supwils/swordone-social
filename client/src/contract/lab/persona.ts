// GENERATED from server/src/contract by contract:sync — do not edit.
/** Per-persona reads: drift, fidelity, drift countdown, collapse watch. */
import { z } from 'zod';
import { labRangeSchema } from './era';

/** The three aspect cards a per-aspect drift measurement scores. */
export const DRIFT_ASPECTS = ['values', 'style', 'topic'] as const;
export type DriftAspect = (typeof DRIFT_ASPECTS)[number];

export const DriftPointDTOSchema = z
  .object({
    capturedAt: z.string(),
    distanceFromAnchor: z.number(),
    distanceFromPrev: z.number(),
    snapshotType: z.enum(['anchor', 'dream']),
    excerpt: z.string(),
    diffNarrative: z.string().optional(),
    /** Per-aspect drift sims; absent on snapshots predating the per-aspect feature. */
    aspects: z
      .object({
        mode: z.enum(['shadow', 'aspect']),
        values: z.number(),
        style: z.number(),
        topic: z.number(),
        breached: z.array(z.enum(DRIFT_ASPECTS)),
      })
      .strict()
      .optional(),
  })
  .strict();
export type DriftPointDTO = z.infer<typeof DriftPointDTOSchema>;

export const FidelityPointDTOSchema = z
  .object({
    capturedAt: z.string(),
    fidelity: z.number().nullable(), // cosine sim(personality, behavior); null if not yet comparable
  })
  .strict();
export type FidelityPointDTO = z.infer<typeof FidelityPointDTOSchema>;

export const FidelityDTOSchema = z
  .object({
    current: z.number().nullable(),
    points: z.array(FidelityPointDTOSchema),
  })
  .strict();
export type FidelityDTO = z.infer<typeof FidelityDTOSchema>;

/** `DRIFT_MODE` as `agent/swil_agent/config.py:33` declares it. */
export const DRIFT_MODES = ['scalar', 'shadow', 'aspect'] as const;
export type DriftMode = (typeof DRIFT_MODES)[number];

/** One measured quantity in the drift series: the whole-document similarity, or one aspect card. */
export const DRIFT_COUNTDOWN_KEYS = ['anchor', 'values', 'style', 'topic'] as const;
export type DriftCountdownKey = (typeof DRIFT_COUNTDOWN_KEYS)[number];

/**
 * Why a series has no projected crossing. Every null on the series below is
 * accounted for by exactly one of these, so a caller never has to guess
 * whether a missing date means "no trend", "no threshold" or "no data".
 *
 * `span-too-short`: declining, with a threshold, but the crossing sits further
 * beyond the last measurement than the measurements themselves span — see
 * `MAX_EXTRAPOLATION` in `persona/countdown.ts`. A DISTINCT reason from
 * `not-declining` on purpose: "this account is not heading for the gate" and
 * "this account is heading for the gate and I have not watched it long
 * enough to say when" are opposite facts about the same account.
 */
export const DRIFT_COUNTDOWN_PROJECTIONS = [
  'fitted',
  'insufficient-points',
  'no-time-span',
  'not-declining',
  'no-threshold',
  'span-too-short',
] as const;
export type DriftCountdownProjection = (typeof DRIFT_COUNTDOWN_PROJECTIONS)[number];

/**
 * One fitted drift series. Every number here is a cosine SIMILARITY (higher =
 * closer to the anchor), never a distance — `DriftPointDTO.distanceFromAnchor`
 * above is the other convention and equals `1 - similarity`.
 */
export const DriftCountdownSeriesDTOSchema = z
  .object({
    key: z.enum(DRIFT_COUNTDOWN_KEYS),
    /** Measurements in the window that carried a finite value for this series. */
    n: z.number(),
    /** The most recent cosine SIMILARITY in the window; null when the window has none. */
    latestSim: z.number().nullable(),
    /** When `latestSim` was measured (ISO). */
    latestAt: z.string().nullable(),
    /** The SIMILARITY threshold in force at the newest measurement; null when it carried none. */
    thresholdSim: z.number().nullable(),
    /** 'event' = read off the wire. 'absent' = the newest measurement predates thresholds being recorded. */
    thresholdBasis: z.enum(['event', 'absent']),
    /**
     * Days between this series' first and last measurement in the window — the
     * base every projection below rests on, and reported whether or not there IS
     * a projection. `n` alone cannot tell four readings taken over three weeks
     * from four taken over twenty minutes, and `r2` cannot either: it measures
     * how well a line fits the points, not whether the points cover enough time
     * to extend that line. Null only when the window holds no reading; `0` when
     * every reading shares one instant.
     */
    spanDays: z.number().nullable(),
    /** OLS slope of SIMILARITY per DAY. Negative = drifting toward rejection. */
    simSlopePerDay: z.number().nullable(),
    /** Coefficient of determination of that fit, [0,1]. A crossing without this is uninterpretable. */
    r2: z.number().nullable(),
    /** ISO instant the fitted line reaches `threshold`. Never in the past — see `crossedAlready`. */
    crossesAt: z.string().nullable(),
    /** Whole rounds from `asOf` to `crossesAt` at `roundIntervalHours`. Never negative. */
    roundsRemaining: z.number().nullable(),
    /** The fit puts the crossing at or before `asOf`: the lockout is current, not upcoming. */
    crossedAlready: z.boolean(),
    projection: z.enum(DRIFT_COUNTDOWN_PROJECTIONS),
  })
  .strict();
export type DriftCountdownSeriesDTO = z.infer<typeof DriftCountdownSeriesDTOSchema>;

/**
 * Projected time-to-lockout for one account, fitted over the UNCENSORED
 * measurement series (`agent_events`, `summary='drift measured'`) rather than
 * over accepted dreams. It projects and enforces nothing.
 */
export const DriftCountdownDTOSchema = z
  .object({
    username: z.string(),
    range: labRangeSchema,
    /** The reference instant for the window and for `roundsRemaining`. */
    asOf: z.string(),
    /** Cadence used to turn days into rounds (`ROUND_MIN_INTERVAL_HOURS`). */
    roundIntervalHours: z.number(),
    /**
     * How far past the last measurement a projection may reach, as a multiple of
     * `spanDays`. Echoed so a reader can recompute a `span-too-short` refusal
     * rather than having to know the server's constant.
     */
    maxExtrapolation: z.number(),
    /** The mode recorded on the newest measurement; null when unknown. */
    driftMode: z.enum(DRIFT_MODES).nullable(),
    /** The series that mode actually gates on. Empty when the mode is unknown. */
    gating: z.array(z.enum(DRIFT_COUNTDOWN_KEYS)),
    /**
     * The gating series that binds — an ALREADY-CROSSED one if any (earliest
     * crossing among them), otherwise the soonest future crossing. Read
     * `crossedAlready` on that series to tell the two apart: `binding` names the
     * constraint, not its tense. Null means no gating series has a crossing this
     * endpoint stands behind, which is NOT the same as "no lockout" — check each
     * series' `projection` for which rule withheld it.
     */
    binding: z.enum(DRIFT_COUNTDOWN_KEYS).nullable(),
    series: z.array(DriftCountdownSeriesDTOSchema),
  })
  .strict();
export type DriftCountdownDTO = z.infer<typeof DriftCountdownDTOSchema>;

/* ---------- act-path collapse detector ---------- */

/**
 * Which way a fitted series points. `flat` is the 6dp-rounded zero slope, so a
 * trend of `1e-9` per day reads as flat rather than as a direction.
 */
export const COLLAPSE_TRENDS = ['down', 'flat', 'up'] as const;
export type CollapseTrend = (typeof COLLAPSE_TRENDS)[number];

/**
 * Why a series was or was not fitted. Every null on `CollapseSeriesDTO` is
 * accounted for by exactly one of these, so a caller never has to guess whether
 * a missing slope means "quiet account" or "instrument did not exist yet".
 *
 * `predates-instrument`: the whole window ends before the act-path
 * self-similarity sampler began filing events (`similarityAvailableFrom`). A
 * DISTINCT reason from `insufficient-points` on purpose: "this account posted
 * too little to fit" and "nothing could have been recorded in this window" are
 * different facts, and the second one is the NORMAL case for any historical
 * window.
 */
export const COLLAPSE_SERIES_FITS = [
  'fitted',
  'insufficient-points',
  'no-time-span',
  'predates-instrument',
] as const;
export type CollapseSeriesFit = (typeof COLLAPSE_SERIES_FITS)[number];

/** One fitted series in the collapse watch. */
export const CollapseSeriesDTOSchema = z
  .object({
    key: z.enum(['length', 'selfSimilarity']),
    /**
     * What the numbers are. `characters` = `char_length(posts.text)`, so a fall
     * is shorter posts. `cosine-similarity` = the act path's `maxSim` against the
     * account's own recent posts, so a RISE is more repetitive output. The two
     * halves of a collapse therefore point in OPPOSITE directions, which is why
     * the verdict below is not a sum.
     */
    unit: z.enum(['characters', 'cosine-similarity']),
    /** Observations in the window that carried a finite value. */
    n: z.number(),
    /** Earliest and latest RAW observations — not the fitted line's endpoints. */
    first: z.number().nullable(),
    firstAt: z.string().nullable(),
    last: z.number().nullable(),
    lastAt: z.string().nullable(),
    /** Days between the first and last observation. Null when the window holds none. */
    spanDays: z.number().nullable(),
    /** OLS slope per DAY, rounded to 6dp; the rounded value is what `trend` is decided on. */
    slopePerDay: z.number().nullable(),
    /**
     * Standard error of that slope. Shipped so a caller can run its own
     * significance test — this endpoint deliberately does not (see
     * `persona/collapse.ts`), and withholding the ingredient would make that
     * choice unauditable.
     */
    slopeStdErr: z.number().nullable(),
    /** Coefficient of determination of the fit, [0,1]. A trend without this is uninterpretable. */
    r2: z.number().nullable(),
    trend: z.enum(COLLAPSE_TRENDS).nullable(),
    fit: z.enum(COLLAPSE_SERIES_FITS),
  })
  .strict();
export type CollapseSeriesDTO = z.infer<typeof CollapseSeriesDTOSchema>;

/**
 * What the verdict rests on. `length-only` is the NORMAL answer for any window
 * ending before the self-similarity sampler existed, not a rare fallback —
 * which is why it is a first-class value rather than an absent field.
 * `similarity-only` is deliberately not a member: the verdict never rests on
 * the similarity half alone, so a window whose length series would not fit
 * reports `none` and `insufficient-data` however much similarity data it holds.
 * Read `selfSimilarity.n` / `.fit` for what the other half actually had.
 */
export const COLLAPSE_BASES = ['both', 'length-only', 'none'] as const;
export type CollapseBasis = (typeof COLLAPSE_BASES)[number];

/**
 * `collapsing` is reachable ONLY with `basis: 'both'` — shorter posts AND
 * rising self-similarity, two independent signs agreeing. `shrinking` is the
 * one-legged answer: posts are getting shorter, and either there was no
 * similarity series to corroborate it (`basis: 'length-only'`) or there was one
 * and it did not agree (`basis: 'both'`, `selfSimilarity.trend` not `up`). The
 * two can never be confused for one another, which is the point of splitting
 * them.
 */
export const COLLAPSE_VERDICTS = [
  'collapsing',
  'shrinking',
  'steady',
  'insufficient-data',
] as const;
export type CollapseVerdict = (typeof COLLAPSE_VERDICTS)[number];

/**
 * Act-path collapse watch for one account over an explicit window. It measures
 * and enforces nothing: no value here reaches the gate, the act path, or any
 * agent's prompt.
 */
export const CollapseWatchDTOSchema = z
  .object({
    username: z.string(),
    /** The window actually fitted, inclusive at both ends. */
    since: z.string(),
    until: z.string(),
    /** Minimum observations a series needs before it is fitted at all. */
    minPoints: z.number(),
    /**
     * The instant the `maxSim` series can first exist. Echoed so a reader can see
     * for themselves why a historical window is `length-only`, instead of having
     * to know the server's constant.
     */
    similarityAvailableFrom: z.string(),
    basis: z.enum(COLLAPSE_BASES),
    verdict: z.enum(COLLAPSE_VERDICTS),
    /** Characters per post. The half with history back to 2026-04. */
    length: CollapseSeriesDTOSchema,
    /** The act path's `maxSim`. The half that starts 2026-08-19. */
    selfSimilarity: CollapseSeriesDTOSchema,
  })
  .strict();
export type CollapseWatchDTO = z.infer<typeof CollapseWatchDTOSchema>;

/**
 * Pure statistics for the arms report (amendment 1, "Decision rule"). No DB.
 *
 * Every function is null-safe: too little data yields `null`, a non-finite
 * input is treated as missing, and a non-finite result becomes `null` — the
 * report must never serialise NaN or Infinity.
 */
import type { ArmId } from '../lab/roster';
import type { MetricBlock, Verdict } from '../../../contract/lab/arms';
import { MIN_ARM_ACCOUNTS, MIN_ARM_ROUNDS } from './protocol';

function finiteOrNull(x: number): number | null {
  return Number.isFinite(x) ? x : null;
}

function finite(values: readonly (number | null)[]): number[] {
  return values.filter((v): v is number => v !== null && Number.isFinite(v));
}

/** Arithmetic mean of the finite values, or null when there are none. */
export function mean(values: readonly number[]): number | null {
  const xs = finite(values);
  if (xs.length === 0) return null;
  let sum = 0;
  for (const x of xs) sum += x;
  return finiteOrNull(sum / xs.length);
}

/** Sample standard deviation (n − 1) of the finite values; null below two. */
export function sampleSd(values: readonly number[]): number | null {
  const xs = finite(values);
  if (xs.length < 2) return null;
  const m = mean(xs);
  if (m === null) return null;
  let ss = 0;
  for (const x of xs) ss += (x - m) * (x - m);
  return finiteOrNull(Math.sqrt(ss / (xs.length - 1)));
}

/**
 * OLS slope of y on x. Pairs with a non-finite coordinate are dropped first;
 * null on mismatched lengths or fewer than `minDistinctX` (at least 2)
 * distinct x values.
 */
export function olsSlope(
  xs: readonly number[],
  ys: readonly number[],
  minDistinctX = 2,
): number | null {
  if (xs.length !== ys.length) return null;
  const px: number[] = [];
  const py: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) {
      px.push(xs[i]);
      py.push(ys[i]);
    }
  }
  if (new Set(px).size < Math.max(2, minDistinctX)) return null;
  const mx = mean(px);
  const my = mean(py);
  if (mx === null || my === null) return null;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < px.length; i++) {
    sxy += (px[i] - mx) * (py[i] - my);
    sxx += (px[i] - mx) * (px[i] - mx);
  }
  if (sxx === 0) return null;
  return finiteOrNull(sxy / sxx);
}

/** One arm's account statistics (null = the account has none). */
export interface ArmStatistics {
  arm: ArmId;
  values: readonly (number | null)[];
}

export type ArmSummary = MetricBlock['arms'][number];

/**
 * Mean / sample SD of each arm's account statistics. A *qualifying arm* has
 * ≥ 9 rounds of data and ≥ 2 accounts with a statistic (and so a finite SD).
 */
export function armSummaries(
  statistics: readonly ArmStatistics[],
  armRounds: Partial<Record<ArmId, number>>,
): ArmSummary[] {
  return statistics.map(({ arm, values }) => {
    const xs = finite(values);
    const m = mean(xs);
    const sd = sampleSd(xs);
    const qualifies =
      (armRounds[arm] ?? 0) >= MIN_ARM_ROUNDS &&
      xs.length >= MIN_ARM_ACCOUNTS &&
      m !== null &&
      sd !== null;
    return { arm, mean: m, sd, accounts: xs.length, qualifies };
  });
}

/**
 * The decision rule. `between` = sample SD of the qualifying arms' means,
 * `within` = mean of their SDs. Status order: `collecting` whenever the window
 * is not frozen (between/within are then provisional values) → after the
 * freeze, `insufficient` (< 2 qualifying arms, or the caller's data gate
 * failed) → `differs` iff between > within, else `no-difference`.
 */
export function verdict(input: {
  statistics: readonly ArmStatistics[];
  armRounds: Partial<Record<ArmId, number>>;
  frozenAt: string | null;
  sufficient?: boolean;
}): Verdict {
  const qualifying = armSummaries(input.statistics, input.armRounds).filter((a) => a.qualifies);
  const between = sampleSd(qualifying.map((a) => a.mean as number));
  const within = mean(qualifying.map((a) => a.sd as number));
  const base = { between, within, frozenAt: input.frozenAt };
  if (input.frozenAt === null) return { status: 'collecting', ...base };
  if (qualifying.length < 2 || between === null || within === null || input.sufficient === false) {
    return { status: 'insufficient', ...base };
  }
  return { status: between > within ? 'differs' : 'no-difference', ...base };
}

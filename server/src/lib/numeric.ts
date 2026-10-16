/**
 * Small numeric helpers shared by the lab reads (bench, pulse, runtime, arms
 * metrics, countdown). One definition each, so "a finite number or nothing"
 * and "the mean of these" cannot drift apart between modules.
 *
 * `modules/agents/arms/stats.ts` keeps its own `mean` / `sampleSd` on purpose:
 * it computes the pre-registered Era 3 statistics and is not touched (S6).
 */

/** `x` when it is a finite number, otherwise null (NaN, ±Infinity, non-numbers). */
export function finiteOrNull(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

/** `x` when it is a finite number, otherwise `fallback`. */
export function finiteOr(x: unknown, fallback: number): number {
  return finiteOrNull(x) ?? fallback;
}

/** Arithmetic mean of the numbers, skipping null / undefined; null when there are none. */
export function meanOf(xs: ReadonlyArray<number | null | undefined>): number | null {
  const v = xs.filter((x): x is number => typeof x === 'number');
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/**
 * POPULATION standard deviation (divides by n, not n − 1) — 0 below two
 * values. The bench's consistency score has always used this form; the arms
 * report's `sampleSd` (n − 1) is a different statistic and stays separate.
 */
export function populationSd(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

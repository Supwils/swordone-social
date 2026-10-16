/**
 * Ordinary least squares of y on x — the shared core of the lab's per-account
 * trend fits (`persona/countdown.ts`, `persona/collapse.ts`).
 *
 * Pure and UNROUNDED. Both callers round the slope to 6 dp and then measure
 * residuals against that rounded line (the line they report), so this exposes
 * the pieces they need for that — the means and `sxx` — alongside the plain
 * fit. `arms/stats.ts` keeps its own `olsSlope` on purpose: it feeds the
 * pre-registered Era 3 slopes and is not touched (S6 ruling 13).
 */

export interface OlsFit {
  n: number;
  xBar: number;
  yBar: number;
  /** Σ(x − x̄)². Zero when every x is equal: the slope is then undefined. */
  sxx: number;
  /** Σ(x − x̄)(y − ȳ). */
  sxy: number;
  /** sxy / sxx — NaN or ±Infinity when `sxx` is 0; callers refuse that case first. */
  slope: number;
}

/** Means, sums of squares and the slope. `xs` and `ys` must have equal length ≥ 1. */
export function olsFit(xs: readonly number[], ys: readonly number[]): OlsFit {
  const n = xs.length;
  const xBar = xs.reduce((a, b) => a + b, 0) / n;
  const yBar = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    sxx += (xs[i] - xBar) ** 2;
    sxy += (xs[i] - xBar) * (ys[i] - yBar);
  }
  return { n, xBar, yBar, sxx, sxy, slope: sxy / sxx };
}

/**
 * Residual and total sums of squares of `ys` against the line with the given
 * `slope` through the centroid (`intercept = ȳ − slope·x̄`). Passing a rounded
 * slope gives the residuals of the line a caller actually reports.
 */
export function olsResiduals(
  xs: readonly number[],
  ys: readonly number[],
  fit: Pick<OlsFit, 'xBar' | 'yBar'>,
  slope: number,
): { intercept: number; ssRes: number; ssTot: number } {
  const intercept = fit.yBar - slope * fit.xBar;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < xs.length; i += 1) {
    ssRes += (ys[i] - (intercept + slope * xs[i])) ** 2;
    ssTot += (ys[i] - fit.yBar) ** 2;
  }
  return { intercept, ssRes, ssTot };
}

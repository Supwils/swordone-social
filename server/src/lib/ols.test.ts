import { describe, expect, it } from 'vitest';
import { olsFit, olsResiduals } from './ols';

describe('olsFit', () => {
  it('fits an exact line', () => {
    const fit = olsFit([0, 1, 2, 3], [1, 3, 5, 7]);
    expect(fit).toMatchObject({ n: 4, xBar: 1.5, yBar: 4, sxx: 5, sxy: 10, slope: 2 });
    const r = olsResiduals([0, 1, 2, 3], [1, 3, 5, 7], fit, fit.slope);
    expect(r.intercept).toBe(1);
    expect(r.ssRes).toBe(0);
    expect(r.ssTot).toBe(20);
  });

  it('measures residuals against the slope it is given, not its own', () => {
    const xs = [0, 1, 2];
    const ys = [0, 1, 2];
    const fit = olsFit(xs, ys);
    // A rounded (here: deliberately wrong) slope through the centroid (1, 1).
    const r = olsResiduals(xs, ys, fit, 0);
    expect(r.intercept).toBe(1);
    expect(r.ssRes).toBe(2);
  });

  it('reports sxx = 0 when every x is equal, leaving the refusal to the caller', () => {
    const fit = olsFit([5, 5, 5], [1, 2, 3]);
    expect(fit.sxx).toBe(0);
    expect(Number.isFinite(fit.slope)).toBe(false);
  });
});

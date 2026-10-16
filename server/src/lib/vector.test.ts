import { describe, it, expect } from 'vitest';
import { cosineSim, cosineDist, centroid, meanPairwiseCosine, pairwiseVariance } from './vector';

describe('cosineSim', () => {
  it('returns 1 for identical unit vectors', () => {
    expect(cosineSim([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSim([1, 0], [0, 1])).toBe(0);
  });

  it('returns -1 for opposite unit vectors', () => {
    expect(cosineSim([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('returns null on length mismatch or empty — not a fabricated 0', () => {
    expect(cosineSim([1, 0], [1])).toBeNull();
    expect(cosineSim([], [])).toBeNull();
  });
});

describe('cosineDist', () => {
  it('is null when the similarity is undefined', () => {
    expect(cosineDist([1, 0], [1])).toBeNull();
  });

  it('is 0 for identical vectors and clamps to [0,2]', () => {
    expect(cosineDist([1, 0], [1, 0])).toBe(0);
    expect(cosineDist([1, 0], [-1, 0])).toBeCloseTo(2);
  });

  it('never goes negative on float round-off', () => {
    // a vector dotted with itself can exceed 1 by epsilon
    const v = [0.6, 0.8];
    expect(cosineDist(v, v)).toBeGreaterThanOrEqual(0);
  });
});

describe('centroid', () => {
  it('averages element-wise', () => {
    expect(
      centroid([
        [0, 0],
        [2, 4],
      ]),
    ).toEqual([1, 2]);
  });

  it('returns null for empty input or zero-dim', () => {
    expect(centroid([])).toBeNull();
    expect(centroid([[]])).toBeNull();
  });

  it('skips vectors of mismatched length', () => {
    expect(centroid([[1, 1], [3, 3], [9]])).toEqual([2, 2]);
  });
});

describe('meanPairwiseCosine', () => {
  it('returns 1 for fewer than 2 usable vectors', () => {
    expect(meanPairwiseCosine([])).toBe(1);
    expect(meanPairwiseCosine([[1, 0]])).toBe(1);
  });

  it('is 1 for identical vectors (max cohesion)', () => {
    expect(
      meanPairwiseCosine([
        [1, 0],
        [1, 0],
        [1, 0],
      ]),
    ).toBeCloseTo(1);
  });

  it('is 0 for mutually orthogonal vectors', () => {
    expect(
      meanPairwiseCosine([
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ]),
    ).toBeCloseTo(0);
  });

  it('ignores empty vectors', () => {
    expect(meanPairwiseCosine([[1, 0], [1, 0], []])).toBeCloseTo(1);
  });

  it('skips a length-mismatched pair instead of averaging in a 0', () => {
    expect(meanPairwiseCosine([[1, 0], [1, 0], [1]])).toBeCloseTo(1);
  });
});

describe('pairwiseVariance', () => {
  it('returns 1 (diverse) for fewer than 3 vectors', () => {
    expect(
      pairwiseVariance([
        [1, 0],
        [0, 1],
      ]),
    ).toBe(1);
  });

  it('is ~0 when all pairwise sims are equal', () => {
    // three mutually orthogonal vectors → all pairwise sims are 0 → variance 0
    expect(
      pairwiseVariance([
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ]),
    ).toBeCloseTo(0);
  });

  it('is positive when pairwise sims differ', () => {
    // two identical + one orthogonal → sims are {1, 0, 0} → non-zero variance
    expect(
      pairwiseVariance([
        [1, 0],
        [1, 0],
        [0, 1],
      ]),
    ).toBeGreaterThan(0);
  });
});

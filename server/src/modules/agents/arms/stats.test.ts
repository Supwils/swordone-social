import { describe, expect, it } from 'vitest';
import type { ArmId } from '../lab/roster';
import { armSummaries, mean, olsSlope, sampleSd, verdict, type ArmStatistics } from './stats';

const ZERO_ROUNDS: Record<ArmId, number> = {
  openai: 0,
  grok: 0,
  gemini: 0,
  'claude-opus': 0,
  'claude-haiku': 0,
};
const FULL_ROUNDS: Record<ArmId, number> = {
  openai: 12,
  grok: 12,
  gemini: 12,
  'claude-opus': 12,
  'claude-haiku': 12,
};

describe('mean', () => {
  it('is null for an empty input', () => {
    expect(mean([])).toBeNull();
  });

  it('averages finite values', () => {
    expect(mean([1, 2, 3, 6])).toBe(3);
    expect(mean([-0.5])).toBe(-0.5);
  });

  it('ignores non-finite values and is null when nothing finite remains', () => {
    expect(mean([1, Number.NaN, 3, Number.POSITIVE_INFINITY])).toBe(2);
    expect(mean([Number.NaN, Number.NEGATIVE_INFINITY])).toBeNull();
  });

  it('is null rather than Infinity when the sum overflows', () => {
    expect(mean([Number.MAX_VALUE, Number.MAX_VALUE])).toBeNull();
  });
});

describe('sampleSd', () => {
  it('is null below two values', () => {
    expect(sampleSd([])).toBeNull();
    expect(sampleSd([4])).toBeNull();
    expect(sampleSd([4, Number.NaN])).toBeNull();
  });

  it('uses the n − 1 denominator', () => {
    // mean 5, squared deviations 9+1+1+9 = 20, / 3
    expect(sampleSd([2, 4, 6, 8])).toBeCloseTo(Math.sqrt(20 / 3), 12);
    expect(sampleSd([1, 3])).toBeCloseTo(Math.SQRT2, 12);
  });

  it('is exactly 0 for identical values', () => {
    expect(sampleSd([0.3, 0.3, 0.3])).toBe(0);
  });

  it('is null rather than Infinity on overflow', () => {
    expect(sampleSd([Number.MAX_VALUE, -Number.MAX_VALUE])).toBeNull();
  });
});

describe('olsSlope', () => {
  it('recovers an exact line', () => {
    expect(olsSlope([1, 2, 3, 4], [0.9, 0.8, 0.7, 0.6])).toBeCloseTo(-0.1, 12);
    expect(olsSlope([1, 3], [0, 4])).toBe(2);
  });

  it('fits repeated x values (several posts in one round)', () => {
    // x̄ = 2, ȳ = 2; Sxy = (−1)(−1)+(−1)(1)+(1)(1)+(1)(3) = 4; Sxx = 4 → 1
    expect(olsSlope([1, 1, 3, 3], [1, 3, 3, 5])).toBe(1);
  });

  it('is null for fewer than two distinct x', () => {
    expect(olsSlope([], [])).toBeNull();
    expect(olsSlope([2], [0.5])).toBeNull();
    expect(olsSlope([2, 2, 2], [0.1, 0.5, 0.9])).toBeNull();
  });

  it('honours a higher distinct-x requirement', () => {
    expect(olsSlope([1, 2], [0, 1], 3)).toBeNull();
    expect(olsSlope([1, 1, 2, 2], [0, 0, 1, 1], 3)).toBeNull();
    expect(olsSlope([1, 2, 3], [0, 1, 2], 3)).toBe(1);
  });

  it('is null on mismatched lengths', () => {
    expect(olsSlope([1, 2, 3], [1, 2])).toBeNull();
  });

  it('drops pairs with a non-finite coordinate before counting', () => {
    expect(olsSlope([1, 2, 3], [0, Number.NaN, 2])).toBe(1);
    expect(olsSlope([1, 2, 3], [0, Number.NaN, 2], 3)).toBeNull();
    expect(olsSlope([1, Number.POSITIVE_INFINITY], [0, 1])).toBeNull();
  });

  it('is 0 for a flat series', () => {
    expect(olsSlope([1, 2, 3], [0.4, 0.4, 0.4])).toBe(0);
  });
});

describe('armSummaries', () => {
  it('summarises every arm given, nulls where too few accounts', () => {
    const stats: ArmStatistics[] = [
      { arm: 'openai', values: [0.1, 0.3, null, Number.NaN] },
      { arm: 'grok', values: [0.2] },
      { arm: 'gemini', values: [] },
    ];
    const out = armSummaries(stats, FULL_ROUNDS);
    expect(out).toEqual([
      {
        arm: 'openai',
        mean: 0.2,
        sd: expect.closeTo(Math.SQRT1_2 * 0.2, 12),
        accounts: 2,
        qualifies: true,
      },
      { arm: 'grok', mean: 0.2, sd: null, accounts: 1, qualifies: false },
      { arm: 'gemini', mean: null, sd: null, accounts: 0, qualifies: false },
    ]);
  });

  it('needs 9 rounds of data to qualify: 8 does not', () => {
    const stats: ArmStatistics[] = [{ arm: 'openai', values: [0.1, 0.2, 0.3] }];
    expect(armSummaries(stats, { ...ZERO_ROUNDS, openai: 8 })[0].qualifies).toBe(false);
    expect(armSummaries(stats, { ...ZERO_ROUNDS, openai: 9 })[0].qualifies).toBe(true);
  });

  it('treats a missing armRounds entry as zero rounds', () => {
    const out = armSummaries([{ arm: 'grok', values: [1, 2] }], {});
    expect(out[0].qualifies).toBe(false);
  });
});

describe('verdict', () => {
  const differing: ArmStatistics[] = [
    { arm: 'openai', values: [-0.05, -0.051, -0.049, -0.05] },
    { arm: 'grok', values: [0.0, 0.001, -0.001, 0.0] },
    { arm: 'gemini', values: [0.0, 0.001, -0.001, 0.0] },
  ];
  const identical: ArmStatistics[] = [
    { arm: 'openai', values: [-0.01, 0, 0.01, 0.02] },
    { arm: 'grok', values: [-0.01, 0, 0.01, 0.02] },
    { arm: 'gemini', values: [-0.01, 0, 0.01, 0.02] },
  ];

  it('is collecting with no data at all (window not frozen)', () => {
    expect(verdict({ statistics: [], armRounds: ZERO_ROUNDS, frozenAt: null })).toEqual({
      status: 'collecting',
      between: null,
      within: null,
      frozenAt: null,
    });
  });

  it('is insufficient with fewer than two qualifying arms, even when frozen', () => {
    const v = verdict({
      statistics: differing,
      armRounds: { ...ZERO_ROUNDS, openai: 12 },
      frozenAt: 'R12',
    });
    expect(v.status).toBe('insufficient');
    expect(v.between).toBeNull();
    expect(v.frozenAt).toBe('R12');
  });

  it('is collecting, not insufficient, before the freeze with < 2 qualifying arms', () => {
    const v = verdict({
      statistics: differing,
      armRounds: { ...ZERO_ROUNDS, openai: 12 },
      frozenAt: null,
    });
    expect(v.status).toBe('collecting');
    expect(v.between).toBeNull();
  });

  it('is collecting before the freeze even when the data gate fails', () => {
    const v = verdict({
      statistics: differing,
      armRounds: FULL_ROUNDS,
      frozenAt: null,
      sufficient: false,
    });
    expect(v.status).toBe('collecting');
  });

  it('is insufficient after the freeze when the caller says the data gate failed', () => {
    const v = verdict({
      statistics: differing,
      armRounds: FULL_ROUNDS,
      frozenAt: 'R12',
      sufficient: false,
    });
    expect(v.status).toBe('insufficient');
  });

  it('is collecting before the 12th completed round, with provisional values', () => {
    const v = verdict({ statistics: differing, armRounds: FULL_ROUNDS, frozenAt: null });
    expect(v.status).toBe('collecting');
    expect(v.between).not.toBeNull();
    expect(v.within).not.toBeNull();
  });

  it('reports a difference when between > within after the freeze', () => {
    const v = verdict({ statistics: differing, armRounds: FULL_ROUNDS, frozenAt: 'R12' });
    expect(v.status).toBe('differs');
    expect(v.between!).toBeGreaterThan(v.within!);
    // between = SD of arm means (−0.05, 0, 0); within = mean of arm SDs
    expect(v.between).toBeCloseTo(sampleSd([-0.05, 0, 0])!, 12);
    expect(v.frozenAt).toBe('R12');
  });

  it('reports no difference for identical arms', () => {
    const v = verdict({ statistics: identical, armRounds: FULL_ROUNDS, frozenAt: 'R12' });
    expect(v.status).toBe('no-difference');
    expect(v.between).toBe(0);
    expect(v.within).toBeCloseTo(sampleSd([-0.01, 0, 0.01, 0.02])!, 12);
  });

  it('ignores non-qualifying arms in between and within', () => {
    const v = verdict({
      statistics: [...identical, { arm: 'claude-opus', values: [5, 6, 7, 8] }],
      armRounds: { ...FULL_ROUNDS, 'claude-opus': 8 },
      frozenAt: 'R12',
    });
    expect(v.status).toBe('no-difference');
    expect(v.between).toBe(0);
  });

  it('never returns NaN or Infinity, whatever the input', () => {
    const v = verdict({
      statistics: [
        { arm: 'openai', values: [Number.NaN, Number.POSITIVE_INFINITY, 1, 2] },
        { arm: 'grok', values: [Number.MAX_VALUE, -Number.MAX_VALUE] },
      ],
      armRounds: FULL_ROUNDS,
      frozenAt: 'R12',
    });
    for (const x of [v.between, v.within]) {
      expect(x === null || Number.isFinite(x)).toBe(true);
    }
    expect(v.status).toBe('insufficient');
  });
});

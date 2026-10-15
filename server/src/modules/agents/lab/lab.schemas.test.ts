import { describe, expect, it } from 'vitest';

import { eraParam, populationRangeQuery, rangeQuery } from './lab.schemas';

describe('era query param (S2 §6)', () => {
  it('defaults to Era 3 and transforms the wire string to a number', () => {
    expect(eraParam.parse(undefined)).toBe(3);
    expect(populationRangeQuery.parse({})).toEqual({ range: '30d', era: 3 });
    expect(populationRangeQuery.parse({ range: '7d', era: '2' })).toEqual({
      range: '7d',
      era: 2,
    });
  });

  it.each(['x', '1', '4', '', '02'])('rejects era=%j', (era) => {
    expect(populationRangeQuery.safeParse({ era }).success).toBe(false);
  });

  it('per-account rangeQuery takes no era: an unknown key is stripped, never a 400', () => {
    const parsed = rangeQuery.safeParse({ range: '7d', era: 'x' });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ range: '7d' });
  });
});

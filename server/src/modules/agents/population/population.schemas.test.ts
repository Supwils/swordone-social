import { describe, expect, it } from 'vitest';

import { listQuery, overviewQuery } from './population.schemas';

describe('era query param on population reads (S2 §6)', () => {
  it('defaults to Era 3 and transforms the wire string to a number', () => {
    expect(listQuery.parse({ era: '3' })).toEqual({ limit: 50, era: 3 });
    expect(listQuery.parse({ era: '2' })).toEqual({ limit: 50, era: 2 });
    expect(overviewQuery.parse({})).toEqual({ era: 3 });
  });

  it.each(['x', '1', '4', '', '02'])('rejects era=%j', (era) => {
    expect(listQuery.safeParse({ era }).success).toBe(false);
    expect(overviewQuery.safeParse({ era }).success).toBe(false);
  });
});

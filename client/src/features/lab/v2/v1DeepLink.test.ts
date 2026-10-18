import { describe, expect, it } from 'vitest';
import { v1DeepLink } from './v1DeepLink';

describe('v1DeepLink', () => {
  it.each([
    ['?era=2', '/lab/v1?era=2'],
    ['?view=benchmark', '/lab/v1?view=benchmark'],
    ['?view=graph', '/lab/v1?view=graph'],
    ['?view=benchmark&agent=xiaoman&range=7d', '/lab/v1?view=benchmark&agent=xiaoman&range=7d'],
    ['?agent=liushang&era=2', '/lab/v1?agent=liushang&era=2'],
  ])('%s → %s, query kept byte for byte', (search, target) => {
    expect(v1DeepLink(search)).toBe(target);
  });

  it.each(['', '?agent=xiaoman', '?round=20261017T062000Z-r', '?era=3', '?view=dashboard'])(
    '%s stays on v2',
    (search) => {
      expect(v1DeepLink(search)).toBeNull();
    },
  );
});

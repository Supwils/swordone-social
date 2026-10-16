import { describe, expect, it } from 'vitest';
import { finiteOr, finiteOrNull, meanOf, populationSd } from './numeric';

describe('numeric helpers', () => {
  it('finiteOrNull / finiteOr keep finite numbers only', () => {
    expect(finiteOrNull(1.5)).toBe(1.5);
    for (const bad of [NaN, Infinity, -Infinity, '1', null, undefined]) {
      expect(finiteOrNull(bad)).toBeNull();
      expect(finiteOr(bad, 0)).toBe(0);
    }
  });

  it('meanOf skips nulls and is null when nothing is left', () => {
    expect(meanOf([1, null, 3, undefined])).toBe(2);
    expect(meanOf([null])).toBeNull();
    expect(meanOf([])).toBeNull();
  });

  it('populationSd divides by n (not n − 1) and is 0 below two values', () => {
    expect(populationSd([2, 4])).toBe(1);
    expect(populationSd([7])).toBe(0);
    expect(populationSd([])).toBe(0);
  });
});

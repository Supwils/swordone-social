import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TTLCache } from './ttlCache';

describe('TTLCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns undefined for missing keys', () => {
    const c = new TTLCache<string, number>(1000);
    expect(c.get('x')).toBeUndefined();
  });

  it('returns set values within the TTL window', () => {
    const c = new TTLCache<string, number>(1000);
    c.set('x', 42);
    expect(c.get('x')).toBe(42);
  });

  it('expires values after the TTL elapses', () => {
    const c = new TTLCache<string, number>(1000);
    c.set('x', 42);
    vi.advanceTimersByTime(1001);
    expect(c.get('x')).toBeUndefined();
  });

  it('does not expire values just before the TTL boundary', () => {
    const c = new TTLCache<string, number>(1000);
    c.set('x', 42);
    vi.advanceTimersByTime(999);
    expect(c.get('x')).toBe(42);
  });

  it('delete removes a single entry', () => {
    const c = new TTLCache<string, number>(1000);
    c.set('x', 1);
    c.set('y', 2);
    c.delete('x');
    expect(c.get('x')).toBeUndefined();
    expect(c.get('y')).toBe(2);
  });

  it('clear removes everything', () => {
    const c = new TTLCache<string, number>(1000);
    c.set('a', 1);
    c.set('b', 2);
    c.clear();
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBeUndefined();
  });

  describe('getOrLoad', () => {
    it('runs the loader on miss and caches the result', async () => {
      const c = new TTLCache<string, number>(1000);
      const loader = vi.fn().mockResolvedValue(42);
      const v = await c.getOrLoad('x', loader);
      expect(v).toBe(42);
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it('skips the loader on hit', async () => {
      const c = new TTLCache<string, number>(1000);
      const loader = vi.fn().mockResolvedValue(42);
      await c.getOrLoad('x', loader);
      const v = await c.getOrLoad('x', loader);
      expect(v).toBe(42);
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it('re-runs loader after TTL expiry', async () => {
      const c = new TTLCache<string, number>(1000);
      const loader = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
      const a = await c.getOrLoad('x', loader);
      vi.advanceTimersByTime(1001);
      const b = await c.getOrLoad('x', loader);
      expect(a).toBe(1);
      expect(b).toBe(2);
      expect(loader).toHaveBeenCalledTimes(2);
    });

    it('shares one loader run between concurrent callers (single-flight)', async () => {
      const c = new TTLCache<string, number>(1000);
      let resolve: (v: number) => void = () => undefined;
      const loader = vi.fn(() => new Promise<number>((r) => (resolve = r)));
      const a = c.getOrLoad('x', loader);
      const b = c.getOrLoad('x', loader);
      resolve(7);
      expect(await Promise.all([a, b])).toEqual([7, 7]);
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it('does not cache a rejected load', async () => {
      const c = new TTLCache<string, number>(1000);
      const loader = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(3);
      await expect(c.getOrLoad('x', loader)).rejects.toThrow('boom');
      expect(await c.getOrLoad('x', loader)).toBe(3);
      expect(loader).toHaveBeenCalledTimes(2);
    });

    it('a load that started before clear() does not repopulate the cache', async () => {
      const c = new TTLCache<string, number>(1000);
      let resolve: (v: number) => void = () => undefined;
      const stale = c.getOrLoad('x', () => new Promise<number>((r) => (resolve = r)));
      c.clear();
      resolve(1);
      expect(await stale).toBe(1);
      expect(c.get('x')).toBeUndefined();
    });
  });

  it('drops expired entries once it grows, not only on a re-read of their key', () => {
    const c = new TTLCache<number, number>(1000);
    for (let i = 0; i < 256; i++) c.set(i, i);
    vi.advanceTimersByTime(1001);
    c.set(999, 1);
    expect(c.size).toBe(1);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { pingDb } from './client';

describe('pingDb', () => {
  it('is true when the test database answers select 1 (its own connection)', async () => {
    expect(await pingDb()).toBe(true);
  });

  it('is false when the query fails', async () => {
    expect(await pingDb(1_000, () => Promise.reject(new Error('down')))).toBe(false);
  });

  it('is false when the query does not answer within the timeout', async () => {
    expect(await pingDb(10, () => new Promise(() => undefined))).toBe(false);
  });

  it('shares one in-flight ping between concurrent callers', async () => {
    let resolve: () => void = () => undefined;
    const query = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    const a = pingDb(1_000, query);
    const b = pingDb(1_000, query);
    resolve();
    expect(await Promise.all([a, b])).toEqual([true, true]);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

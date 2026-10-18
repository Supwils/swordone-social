import { describe, expect, it } from 'vitest';
import { EnvSchema } from './env';

const base = {
  DATABASE_URL: 'postgresql://localhost/x_test',
  SESSION_SECRET: 'env-observer-test-secret-0123456789abcdef0123456789',
};

describe('LAB_OBSERVER_TOKEN', () => {
  it('blank or absent means the observer note is off', () => {
    expect(EnvSchema.parse({ ...base, LAB_OBSERVER_TOKEN: '' }).LAB_OBSERVER_TOKEN).toBeUndefined();
    expect(EnvSchema.parse(base).LAB_OBSERVER_TOKEN).toBeUndefined();
  });

  it('accepts 32 characters and refuses 31 — a short token stops the server at boot', () => {
    expect(
      EnvSchema.parse({ ...base, LAB_OBSERVER_TOKEN: 'x'.repeat(32) }).LAB_OBSERVER_TOKEN,
    ).toHaveLength(32);
    expect(EnvSchema.safeParse({ ...base, LAB_OBSERVER_TOKEN: 'x'.repeat(31) }).success).toBe(
      false,
    );
  });
});

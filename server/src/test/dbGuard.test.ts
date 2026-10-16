import { describe, expect, it } from 'vitest';
import { assertDisposableDb } from '../db/target';

describe('assertDisposableDb', () => {
  it.each([
    'postgresql://postgres:postgres@localhost:5432/swil_test',
    'postgresql://me@127.0.0.1:5432/swil_test_pg',
    'postgresql://me@127.0.0.1:5432/swil_e2e_pg',
    'postgresql://me@[::1]:5432/swil_e2e',
    'postgresql://postgres:postgres@postgres:5432/swil_test',
  ])('accepts %s', (uri) => {
    expect(() => assertDisposableDb(uri)).not.toThrow();
  });

  it.each([
    'postgresql://u:secret@ep-cool-1.neon.tech/neondb',
    'postgresql://u:secret@ep-cool-1.neon.tech/swil_test',
    'postgresql://me@localhost:5432/swil_dev',
    'postgresql://me@localhost:5432/swil_test_pg_old',
    'postgresql://me@localhost:5432/',
    'postgresql://me@localhost.evil.com:5432/swil_test',
    'not a url',
    '',
  ])('refuses %s', (uri) => {
    expect(() => assertDisposableDb(uri)).toThrow(/refusing/);
  });

  it('does not echo the password', () => {
    try {
      assertDisposableDb('postgresql://u:hunter2@prod.example.com/app');
    } catch (err) {
      expect((err as Error).message).not.toContain('hunter2');
      return;
    }
    throw new Error('expected a throw');
  });
});

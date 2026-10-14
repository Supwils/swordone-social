import { describe, expect, it } from 'vitest';
import { describeDbTarget } from './target';

describe('describeDbTarget', () => {
  it('keeps host, port and database name and drops the credentials', () => {
    const out = describeDbTarget(
      'postgresql://neondb_owner:s3cret@ep-x.neon.tech:5432/neondb?sslmode=require',
    );
    expect(out).toBe('ep-x.neon.tech:5432/neondb');
    expect(out).not.toContain('s3cret');
    expect(out).not.toContain('neondb_owner');
  });

  it('omits an absent port and an absent database name', () => {
    expect(describeDbTarget('postgres://u:p@127.0.0.1')).toBe('127.0.0.1');
    expect(describeDbTarget('postgres://127.0.0.1/swil_test_pg')).toBe('127.0.0.1/swil_test_pg');
  });

  it('never echoes a string it cannot parse', () => {
    expect(describeDbTarget('user:pw@not a url')).toBe('(unparseable DATABASE_URL)');
  });
});

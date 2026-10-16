import { describe, expect, it } from 'vitest';
import {
  REMOTE_OVERRIDE_FLAG,
  describeDbTarget,
  isLocalDbTarget,
  remoteWriteRefusal,
} from './target';

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

describe('isLocalDbTarget', () => {
  it('accepts loopback hosts only', () => {
    expect(isLocalDbTarget('postgresql://u@127.0.0.1:5432/swil_social_pg')).toBe(true);
    expect(isLocalDbTarget('postgresql://localhost/swil')).toBe(true);
    expect(isLocalDbTarget('postgresql://u@[::1]:5432/swil')).toBe(true);
    expect(isLocalDbTarget('postgresql://u:p@ep-x.neon.tech/neondb?sslmode=require')).toBe(false);
    expect(isLocalDbTarget('postgresql://u@127.0.0.1.evil.example/db')).toBe(false);
    expect(isLocalDbTarget('user:pw@not a url')).toBe(false);
  });
});

describe('remoteWriteRefusal', () => {
  const neon = 'postgresql://u:s3cret@ep-x.neon.tech:5432/neondb';

  it('lets a local target through, with or without the override', () => {
    expect(remoteWriteRefusal('postgresql://u@127.0.0.1/swil', ['--reset'])).toBeNull();
    expect(remoteWriteRefusal('postgresql://u@localhost/swil', [])).toBeNull();
  });

  it('refuses a remote target, naming it without credentials and the flag', () => {
    const msg = remoteWriteRefusal(neon, ['--', '--reset']);
    expect(msg).toContain('ep-x.neon.tech:5432/neondb');
    expect(msg).toContain('truncates every table but session');
    expect(msg).toContain(REMOTE_OVERRIDE_FLAG);
    expect(msg).not.toContain('s3cret');
    expect(remoteWriteRefusal(neon, [])).not.toContain('truncates');
  });

  it('refuses an unparseable target', () => {
    expect(remoteWriteRefusal('user:pw@not a url', [])).toMatch(/^refusing: \(unparseable/);
  });

  it('lets a remote target through only with the explicit flag', () => {
    expect(remoteWriteRefusal(neon, ['--reset', REMOTE_OVERRIDE_FLAG])).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { e2eServerEnv } from '../../../e2e/server-env';
import { EnvSchema } from './env';

describe('e2e server env', () => {
  it('satisfies EnvSchema on its own (CI has no server/.env)', () => {
    const env = e2eServerEnv({
      databaseUrl: 'postgresql://postgres:postgres@localhost:5432/swil_e2e_pg',
      serverPort: 8901,
      clientPort: 5948,
    });
    const parsed = EnvSchema.safeParse(env);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data?.SESSION_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(parsed.data?.CORS_ORIGINS).toContain('http://localhost:5948');
  });
});

import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../db/client';
import { FOREIGN_KEYS } from '../db/foreignKeys';
import { migrationStatements, restoreForeignKeyState } from './fkState';

/**
 * The repair globalSetup runs: whatever a killed test left behind (a validated
 * or a dropped 0006 constraint), the next run starts from the migrated state.
 */
async function state(): Promise<Map<string, boolean>> {
  const { rows } = await pool.query<{ conname: string; convalidated: boolean }>(
    "SELECT conname, convalidated FROM pg_constraint WHERE contype = 'f' " +
      "AND connamespace = 'public'::regnamespace",
  );
  return new Map(rows.map((r) => [r.conname, r.convalidated]));
}

describe('restoreForeignKeyState', () => {
  afterAll(() => restoreForeignKeyState(pool));

  it('is a no-op on the migrated state', async () => {
    await restoreForeignKeyState(pool);
    expect(await restoreForeignKeyState(pool)).toBe(false);
  });

  it('re-adds a dropped constraint and un-validates a validated one', async () => {
    await pool.query('ALTER TABLE "likes" DROP CONSTRAINT "likes_user_id_fkey"');
    await pool.query('ALTER TABLE "posts" VALIDATE CONSTRAINT "posts_author_id_fkey"');
    const broken = await state();
    expect(broken.has('likes_user_id_fkey')).toBe(false);
    expect(broken.get('posts_author_id_fkey')).toBe(true);

    expect(await restoreForeignKeyState(pool)).toBe(true);
    const fixed = await state();
    expect([...fixed.keys()].sort()).toEqual(FOREIGN_KEYS.map((fk) => fk.name));
    expect([...fixed.values()].every((v) => v === false)).toBe(true);
    expect(await restoreForeignKeyState(pool)).toBe(false);
  });

  it('reads one IF EXISTS rollback per ADD … NOT VALID from the migration', () => {
    const { drops, adds } = migrationStatements();
    expect(drops).toHaveLength(FOREIGN_KEYS.length);
    expect(adds).toHaveLength(FOREIGN_KEYS.length);
    for (const d of drops) expect(d).toMatch(/DROP CONSTRAINT IF EXISTS "\w+_fkey";$/);
    for (const a of adds) expect(a).toMatch(/^ALTER TABLE .* NOT VALID;$/);
  });

  it('refuses a migration whose rollback lines do not match its statements', () => {
    expect(() => migrationStatements('ALTER TABLE "x" ADD CONSTRAINT "y" NOT VALID;')).toThrow(
      /0 rollback lines for 1 statements/,
    );
  });
});

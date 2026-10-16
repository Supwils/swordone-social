import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/client';
import { FOREIGN_KEYS } from '../src/db/foreignKeys';
import { describeDbTarget } from '../src/db/target';
import { resetDb } from '../src/test/db-reset';
import { restoreForeignKeyState } from '../src/test/fkState';
import { seedFkParents, seedOneOrphanPerConstraint } from '../src/test/orphans';
import { USAGE, main } from './db-validate-fks';

/**
 * `db:validate-fks` against the local test database only. Validating changes
 * catalog state that outlives the test, so every test here ends by putting the
 * constraints back exactly as migration 0006 leaves them (`restoreForeignKeyState`,
 * which globalSetup also runs, so a killed run is repaired by the next one).
 */
const url = process.env.DATABASE_URL!;
const lines: string[] = [];
const out = (line: string) => lines.push(line);

async function run(argv: string[]): Promise<number> {
  lines.length = 0;
  return main(argv, { url, out });
}

async function validated(): Promise<Map<string, boolean>> {
  const { rows } = await pool.query<{ conname: string; convalidated: boolean }>(
    "SELECT conname, convalidated FROM pg_constraint WHERE contype = 'f' " +
      "AND connamespace = 'public'::regnamespace",
  );
  return new Map(rows.map((r) => [r.conname, r.convalidated]));
}

async function restoreMigrationState(): Promise<void> {
  await restoreForeignKeyState(pool);
}

describe('db:validate-fks', () => {
  beforeAll(restoreMigrationState);
  afterAll(restoreMigrationState);
  beforeEach(resetDb);

  it('targets the local test database', () => {
    expect(describeDbTarget(url)).toMatch(/^(127\.0\.0\.1|localhost)(:\d+)?\//);
  });

  it('prints the target and refuses without --yes, changing nothing', async () => {
    expect(await run([])).toBe(2);
    expect(lines[0]).toBe(`target database: ${describeDbTarget(url)}`);
    expect(lines.at(-1)).toMatch(/^refusing: .*--yes/);
    expect([...(await validated()).values()].every((v) => v === false)).toBe(true);
  });

  it('refuses when any orphan exists, listing them, and validates nothing', async () => {
    await seedOneOrphanPerConstraint(await seedFkParents());
    expect(await run(['--yes'])).toBe(1);
    expect(lines.at(-1)).toMatch(/^refusing: 17 constraint\(s\) have orphans/);
    expect([...(await validated()).values()].every((v) => v === false)).toBe(true);
  });

  it('validates every constraint on a clean database, then reports them already valid', async () => {
    await seedFkParents();
    expect(await run(['--yes'])).toBe(0);
    expect(lines.filter((l) => l.startsWith('validated '))).toHaveLength(FOREIGN_KEYS.length);
    const state = await validated();
    for (const fk of FOREIGN_KEYS) expect(state.get(fk.name)).toBe(true);

    expect(await run(['--yes'])).toBe(0);
    expect(lines.filter((l) => l.startsWith('already valid '))).toHaveLength(FOREIGN_KEYS.length);
    await restoreMigrationState();
    expect([...(await validated()).values()].every((v) => v === false)).toBe(true);
  });

  it('refuses when a constraint is missing (0006 not applied)', async () => {
    await pool.query('ALTER TABLE "likes" DROP CONSTRAINT "likes_user_id_fkey"');
    try {
      expect(await run(['--yes'])).toBe(1);
      expect(lines).toContainEqual(expect.stringMatching(/^likes_user_id_fkey .*\[missing\]$/));
    } finally {
      await restoreMigrationState();
    }
  });

  it('prints usage for --help (exit 0), an unknown flag or no DATABASE_URL (exit 2)', async () => {
    expect(await run(['--help'])).toBe(0);
    expect(lines).toEqual([USAGE]);
    expect(USAGE).toMatch(/DATABASE_URL/);
    expect(await run(['--yes', '--force'])).toBe(2);
    lines.length = 0;
    expect(await main(['--yes'], { url: '', out })).toBe(2);
  });
});

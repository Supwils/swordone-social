import { beforeEach, describe, expect, it } from 'vitest';
import { FOREIGN_KEYS } from '../src/db/foreignKeys';
import { describeDbTarget } from '../src/db/target';
import { resetDb } from '../src/test/db-reset';
import { seedFkParents, seedOneOrphanPerConstraint } from '../src/test/orphans';
import { USAGE, main } from './db-orphans';

/**
 * `db:orphans` against the local test database only (test/setup.ts points
 * DATABASE_URL there; the url is passed explicitly anyway). Review Focus 2:
 * one orphan per constraint → each listed, exit 1; clean → exit 0.
 */
const url = process.env.DATABASE_URL!;
const lines: string[] = [];
const out = (line: string) => lines.push(line);

async function run(argv: string[] = []): Promise<number> {
  lines.length = 0;
  return main(argv, { url, out });
}

describe('db:orphans', () => {
  beforeEach(resetDb);

  it('targets the local test database', () => {
    expect(describeDbTarget(url)).toMatch(/^(127\.0\.0\.1|localhost)(:\d+)?\//);
  });

  it('prints the target first and exits 0 on a clean database', async () => {
    await seedFkParents();
    expect(await run()).toBe(0);
    expect(lines[0]).toBe(`target database: ${describeDbTarget(url)}`);
    expect(lines.at(-1)).toBe(`db:orphans — clean (${FOREIGN_KEYS.length} constraints)`);
  });

  it('lists every constraint with its orphan and exits 1', async () => {
    await seedOneOrphanPerConstraint(await seedFkParents());
    expect(await run()).toBe(1);
    for (const fk of FOREIGN_KEYS) {
      expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^${fk.name}\\s+1 orphan`)));
    }
    expect(lines.at(-1)).toBe(
      `db:orphans — ${FOREIGN_KEYS.length} orphan row(s) across ${FOREIGN_KEYS.length} constraint(s)`,
    );
  });

  it('leaves the orphans in place (it never writes)', async () => {
    await seedOneOrphanPerConstraint(await seedFkParents());
    expect(await run()).toBe(1);
    expect(await run()).toBe(1);
  });

  it('prints usage for --help (exit 0) and for an unknown flag (exit 2)', async () => {
    expect(await run(['--help'])).toBe(0);
    expect(lines).toEqual([USAGE]);
    expect(USAGE).toMatch(/DATABASE_URL/);
    expect(USAGE).toMatch(/READ ONLY/);
    expect(await run(['--fix'])).toBe(2);
  });

  it('exits 2 without a DATABASE_URL', async () => {
    lines.length = 0;
    expect(await main([], { url: '', out })).toBe(2);
    expect(lines).toEqual(['DATABASE_URL is not set']);
  });
});

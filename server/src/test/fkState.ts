import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Put the 0006 foreign keys back exactly as a fresh migrate leaves them: all
 * 17 present and NOT VALID. Tests that validate or drop constraints change
 * catalog state the migrator never revisits (0006 stays "applied"), so a run
 * killed mid-test would leave the shared test database wrong for every later
 * run. globalSetup calls this after migrating; the validate-script test calls
 * it around its own catalog changes.
 *
 * Idempotent and a no-op when the state is already right. Otherwise it runs
 * the migration header's rollback lines (with IF EXISTS) and then the
 * migration's own ADD … NOT VALID statements — which also exercises the
 * documented rollback.
 */
export interface QueryRunner {
  query(text: string): Promise<{ rows: Record<string, unknown>[] }>;
}

const MIGRATION_FILE = join(__dirname, '../db/migrations/0006_platform_foreign_keys.sql');

export function migrationStatements(sqlText = readFileSync(MIGRATION_FILE, 'utf8')): {
  drops: string[];
  adds: string[];
} {
  const drops = [...sqlText.matchAll(/^-- {3}(ALTER TABLE "\w+" DROP CONSTRAINT "\w+";)$/gm)].map(
    (m) => m[1].replace('DROP CONSTRAINT', 'DROP CONSTRAINT IF EXISTS'),
  );
  const adds = sqlText
    .split('--> statement-breakpoint')
    .map((s) => s.replace(/^--.*$/gm, '').trim())
    .filter(Boolean);
  if (drops.length === 0 || drops.length !== adds.length) {
    throw new Error(`0006: ${drops.length} rollback lines for ${adds.length} statements`);
  }
  return { drops, adds };
}

/** Returns true when it had to repair the catalog. */
export async function restoreForeignKeyState(runner: QueryRunner): Promise<boolean> {
  const { drops, adds } = migrationStatements();
  const expected = adds.map((a) => /ADD CONSTRAINT "(\w+)"/.exec(a)![1]);
  const { rows } = await runner.query(
    "SELECT conname, convalidated FROM pg_constraint WHERE contype = 'f' " +
      "AND connamespace = 'public'::regnamespace",
  );
  const state = new Map(rows.map((r) => [String(r.conname), r.convalidated === true]));
  const clean = state.size === expected.length && expected.every((n) => state.get(n) === false);
  if (clean) return false;
  for (const stmt of drops) await runner.query(stmt);
  for (const stmt of adds) await runner.query(stmt);
  return true;
}

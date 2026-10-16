import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { assertDisposableDb } from '../db/target';
import { restoreForeignKeyState } from './fkState';

/**
 * Vitest globalSetup — runs once before the whole suite. Applies Drizzle
 * migrations to the test database so every test starts against a real,
 * up-to-date Postgres schema. Individual DB-touching suites call `resetDb()`
 * (src/test/db-reset.ts) in beforeEach for isolation.
 */
export default async function setup(): Promise<void> {
  process.env.NODE_ENV ??= 'test';
  // Fall back to a local superuser role named after the current OS user — the
  // default for a `brew install postgresql` setup. Previously this was
  // hardcoded to one maintainer's username, so `ci:check` failed at step 5/10
  // on every other machine. CI and Docker set DATABASE_URL explicitly.
  const url =
    process.env.DATABASE_URL ??
    `postgresql://${process.env.USER ?? 'postgres'}@127.0.0.1:5432/swil_test_pg`;
  // The suite TRUNCATEs this database; a shell-exported production URL must never reach it.
  assertDisposableDb(url);
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: `${__dirname}/../db/migrations` });
  // A killed run of the validate-script test can leave 0006's constraints
  // validated or dropped; the migrator never revisits an applied file.
  try {
    await restoreForeignKeyState(pool);
  } finally {
    await pool.end();
  }
}

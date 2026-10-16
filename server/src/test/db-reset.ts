import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { truncateStatement } from '../db/tables';

/**
 * Truncate every application table for a clean slate between tests.
 * Call in `beforeEach` of any suite that touches the DB. Requires
 * DATABASE_URL to point at the test database (see test/setup.ts).
 *
 * One `TRUNCATE … CASCADE` over every schema table (derived from the schema,
 * so a new table is never left out) — safe under the 0006 foreign keys.
 */
export async function resetDb(): Promise<void> {
  await db.execute(sql.raw(truncateStatement()));
}

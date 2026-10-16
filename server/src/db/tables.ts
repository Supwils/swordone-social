import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as schema from './schema';

/**
 * Every table the Drizzle schema declares, derived rather than listed so a new
 * table is never missed by a reset. Importing this does not open a connection
 * (no `db/client`, no `config/env`), so scripts can use it before deciding
 * which database to touch.
 */
export const APP_TABLES: readonly PgTable[] = (Object.values(schema) as unknown[]).filter(
  (v): v is PgTable => is(v, PgTable),
);

export const APP_TABLE_NAMES: readonly string[] = APP_TABLES.map((t) => getTableName(t)).sort();

/**
 * One `TRUNCATE … RESTART IDENTITY CASCADE` over the app tables. A single
 * statement truncates parents and children together, so the 0006 foreign keys
 * cannot reject it (row-by-row `DELETE`s in parallel would). `except` keeps
 * tables out — `seed --reset` keeps `session`.
 */
export function truncateStatement(except: readonly string[] = []): string {
  const names = APP_TABLE_NAMES.filter((n) => !except.includes(n));
  if (names.length === 0) throw new Error('truncateStatement: no tables left to truncate');
  return `TRUNCATE ${names.map((n) => `"${n}"`).join(', ')} RESTART IDENTITY CASCADE`;
}

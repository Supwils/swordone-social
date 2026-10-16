import { Client, Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import { env } from '../config/env';
import { logger } from '../lib/logger';

/**
 * Single shared pg connection pool + Drizzle instance.
 *
 * A persistent server holds a small pool (max 10) — the classic, efficient
 * model, and this pool is the pooler. Against Neon, DATABASE_URL is the DIRECT
 * (unpooled) connection string: migrations and session-level settings need a
 * real session, and a server-side pool in front of PgBouncer buys nothing
 * (docs/08-deployment.md).
 */
export const pool = new Pool({ connectionString: env.DATABASE_URL, max: 10 });

export const db: NodePgDatabase<typeof schema> = drizzle(pool, { schema });

let connected = false;

export async function connectDb(): Promise<void> {
  await pool.query('select 1');
  connected = true;
  logger.info({ uri: redact(env.DATABASE_URL) }, 'postgres connected');
}

export async function disconnectDb(): Promise<void> {
  if (!connected) return;
  await pool.end();
  connected = false;
}

/** How long `/health` waits for the database before reporting it down. */
const PING_TIMEOUT_MS = 1_000;

/**
 * `select 1` on a dedicated, short-lived connection — never the shared pool, so
 * a hung database cannot park health checks on pool slots that real requests
 * need. Connect and query are both bounded by `timeoutMs`; the connection is
 * closed either way.
 */
async function pingOnce(timeoutMs: number): Promise<void> {
  const client = new Client({
    connectionString: env.DATABASE_URL,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs,
  });
  try {
    await client.connect();
    await client.query('select 1');
  } finally {
    await client.end().catch(() => undefined);
  }
}

let pingInFlight: Promise<boolean> | null = null;

/**
 * Whether the database answers `select 1` within `timeoutMs`. `/health` used to
 * report a flag set once at boot, so a database that went away after start
 * still read `ok`. Never throws. Single-flight: concurrent health calls share
 * one ping, so at most one extra connection exists however often it is polled.
 * `query` is injectable for the timeout tests.
 */
export function pingDb(
  timeoutMs = PING_TIMEOUT_MS,
  query: (timeoutMs: number) => Promise<unknown> = pingOnce,
): Promise<boolean> {
  if (pingInFlight) return pingInFlight;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A backstop over the driver's own timeouts, so a ping always settles.
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs + 250);
  });
  pingInFlight = Promise.race([query(timeoutMs).then(() => true as const), timeout])
    .catch(() => false)
    .finally(() => {
      clearTimeout(timer);
      pingInFlight = null;
    });
  return pingInFlight;
}

function redact(uri: string): string {
  return uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');
}

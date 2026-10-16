import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import { env } from '../config/env';
import { logger } from '../lib/logger';

/**
 * Single shared pg connection pool + Drizzle instance.
 *
 * A persistent server holds a small pool (max 10) — the classic, efficient
 * model. Against Neon, point DATABASE_URL at the pooled endpoint.
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

export function isDbHealthy(): boolean {
  return connected;
}

function redact(uri: string): string {
  return uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');
}

/**
 * Database lifecycle. Postgres (Drizzle) is the store; the actual pool +
 * Drizzle instance live in `../db/client`. These re-exports keep the old
 * import sites (`server.ts`, health checks) working unchanged.
 */
export { connectDb, disconnectDb, isDbHealthy } from '../db/client';

/**
 * No-op retained for call-site compatibility. Schema + indexes are managed by
 * Drizzle migrations (`npm run db:migrate`), not synced at boot.
 */
export async function syncAllIndexes(): Promise<void> {
  /* migrations own the schema */
}

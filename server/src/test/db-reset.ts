import { sql } from 'drizzle-orm';
import { db } from '../db/client';

/**
 * Truncate every application table for a clean slate between tests.
 * Call in `beforeEach` of any suite that touches the DB. Requires
 * DATABASE_URL to point at the test database (see test/setup.ts).
 */
const TABLES = [
  'likes',
  'bookmarks',
  'follows',
  'comments',
  'posts',
  'messages',
  'conversations',
  'notifications',
  'api_keys',
  'personality_snapshots',
  'behavior_snapshots',
  'agent_events',
  'benchmark_runs',
  'population_metrics',
  'post_vectors',
  'events',
  'tags',
  'boards',
  'users',
  'session',
];

export async function resetDb(): Promise<void> {
  await db.execute(
    sql.raw(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`),
  );
}

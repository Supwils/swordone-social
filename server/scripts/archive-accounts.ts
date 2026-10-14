/**
 * Seal accounts by setting users.archived_at (Era boundary).
 *
 *   npx tsx scripts/archive-accounts.ts --usernames a,b,c            # dry run
 *   npx tsx scripts/archive-accounts.ts --usernames a,b,c --apply    # write
 *
 * Only rows whose archived_at is still NULL are touched. Reads DATABASE_URL
 * from the environment — point it at the intended database yourself. The
 * target host is printed first (credentials redacted), before any write.
 */
import 'dotenv/config';
import { and, inArray, isNull } from 'drizzle-orm';
import { env } from '../src/config/env';
import { db, connectDb, disconnectDb } from '../src/db/client';
import { users } from '../src/db/schema';
import { describeDbTarget } from '../src/db/target';

function parseArgs(argv: string[]): { usernames: string[]; apply: boolean } {
  const i = argv.indexOf('--usernames');
  const raw = i >= 0 ? (argv[i + 1] ?? '') : '';
  const usernames = raw
    .split(',')
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  return { usernames, apply: argv.includes('--apply') };
}

async function run(): Promise<void> {
  const { usernames, apply } = parseArgs(process.argv.slice(2));
  if (usernames.length === 0) {
    throw new Error('usage: archive-accounts.ts --usernames a,b,c [--apply]');
  }
  process.stdout.write(`target database: ${describeDbTarget(env.DATABASE_URL)}\n`);
  await connectDb();

  const pending = and(inArray(users.username, usernames), isNull(users.archivedAt));
  const rows = await db
    .select({ id: users.id, username: users.username, isAgent: users.isAgent })
    .from(users)
    .where(pending);
  const found = new Set(rows.map((r) => r.username));
  const missing = usernames.filter((n) => !found.has(n));

  for (const r of rows) {
    process.stdout.write(`${apply ? 'archive' : 'would archive'} ${r.username} (${r.id})\n`);
  }
  if (missing.length) {
    process.stdout.write(`not found or already archived: ${missing.join(', ')}\n`);
  }

  if (apply && rows.length) {
    await db
      .update(users)
      .set({ archivedAt: new Date() })
      .where(
        and(
          inArray(
            users.id,
            rows.map((r) => r.id),
          ),
          isNull(users.archivedAt),
        ),
      );
    process.stdout.write(`archived ${rows.length} account(s)\n`);
  } else if (!apply) {
    process.stdout.write(`dry run: ${rows.length} account(s); pass --apply to write\n`);
  }
  await disconnectDb();
}

run().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

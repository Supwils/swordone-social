/**
 * Orphan report for the 0006 foreign keys: for each constraint, how many
 * child rows name a parent that does not exist. Read-only.
 *
 *   npm --prefix server run db:orphans
 *
 * Exit 0 clean, 1 if any orphan, 2 on a usage or connection error.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { formatStatus, inspectForeignKeys } from '../src/db/foreignKeys';
import { describeDbTarget } from '../src/db/target';

export const USAGE = [
  'usage: npm --prefix server run db:orphans [-- --help]',
  '',
  'Counts orphans per 0006 foreign key (child rows whose parent id does not exist)',
  'in a READ ONLY transaction that is rolled back; it never writes.',
  'Target: DATABASE_URL from the environment, else server/.env (dotenv) —',
  'point it at the intended database yourself. The target is printed first.',
  'Exit 0 if clean, 1 if any orphan, 2 on a usage or connection error.',
].join('\n');

export interface ScriptIo {
  url?: string;
  out?: (line: string) => void;
}

const stdout = (line: string) => process.stdout.write(`${line}\n`);

export async function main(argv: readonly string[], io: ScriptIo = {}): Promise<number> {
  const out = io.out ?? stdout;
  if (argv.includes('--help') || argv.includes('-h')) {
    out(USAGE);
    return 0;
  }
  if (argv.length > 0) {
    out(USAGE);
    return 2;
  }
  const url = io.url ?? process.env.DATABASE_URL;
  if (!url) {
    out('DATABASE_URL is not set');
    return 2;
  }
  out(`target database: ${describeDbTarget(url)}`);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const statuses = await inspectForeignKeys(client);
    for (const s of statuses) out(formatStatus(s));
    const total = statuses.reduce((n, s) => n + s.orphans, 0);
    const dirty = statuses.filter((s) => s.orphans > 0).length;
    if (total === 0) {
      out(`db:orphans — clean (${statuses.length} constraints)`);
      return 0;
    }
    out(`db:orphans — ${total} orphan row(s) across ${dirty} constraint(s)`);
    return 1;
  } finally {
    await client.end();
  }
}

// Run only as a script, never on import from a test.
if (/db-orphans\.[jt]s$/.test(process.argv[1] ?? '')) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 2;
    },
  );
}

/**
 * Validate the 0006 foreign keys (`ALTER TABLE … VALIDATE CONSTRAINT`), the
 * optional owner step after `db:orphans` reports clean. Writes catalog state,
 * so it refuses to run without `--yes`.
 *
 *   npm --prefix server run db:validate-fks -- --yes
 *
 * Exit 0 validated (or already valid), 1 refused because of orphans or a
 * missing constraint, 2 without `--yes`, on a usage or connection error.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { formatStatus, inspectForeignKeys, validateForeignKeys } from '../src/db/foreignKeys';
import { describeDbTarget } from '../src/db/target';
import type { ScriptIo } from './db-orphans';

export const USAGE = [
  'usage: npm --prefix server run db:validate-fks -- --yes',
  '',
  'Runs ALTER TABLE … VALIDATE CONSTRAINT for every 0006 foreign key still NOT VALID.',
  'It first repeats the db:orphans check (read-only) and refuses if any orphan exists.',
  'Each VALIDATE scans the child table under SHARE UPDATE EXCLUSIVE (reads and writes',
  'continue). Without --yes it prints the target and refuses.',
  'Target: DATABASE_URL from the environment, else server/.env (dotenv) —',
  'point it at the intended database yourself.',
  'Exit 0 done, 1 refused (orphans / constraint missing), 2 no --yes or usage error.',
].join('\n');

const stdout = (line: string) => process.stdout.write(`${line}\n`);

export async function main(argv: readonly string[], io: ScriptIo = {}): Promise<number> {
  const out = io.out ?? stdout;
  if (argv.includes('--help') || argv.includes('-h')) {
    out(USAGE);
    return 0;
  }
  if (argv.some((a) => a !== '--yes')) {
    out(USAGE);
    return 2;
  }
  const url = io.url ?? process.env.DATABASE_URL;
  if (!url) {
    out('DATABASE_URL is not set');
    return 2;
  }
  out(`target database: ${describeDbTarget(url)}`);
  if (!argv.includes('--yes')) {
    out('refusing: VALIDATE CONSTRAINT changes this database; re-run with --yes');
    return 2;
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const statuses = await inspectForeignKeys(client);
    const blocked = statuses.filter((s) => s.orphans > 0 || !s.present);
    if (blocked.length > 0) {
      for (const s of blocked) out(formatStatus(s));
      out(`refusing: ${blocked.length} constraint(s) have orphans or are missing; run db:orphans`);
      return 1;
    }
    for (const r of await validateForeignKeys(client, statuses)) {
      out(`${r.action === 'validated' ? 'validated    ' : 'already valid'} ${r.name}`);
    }
    out(`db:validate-fks — ${statuses.length} constraints valid`);
    return 0;
  } finally {
    await client.end();
  }
}

// Run only as a script, never on import from a test.
if (/db-validate-fks\.[jt]s$/.test(process.argv[1] ?? '')) {
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

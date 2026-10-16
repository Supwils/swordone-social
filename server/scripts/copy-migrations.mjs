// Post-build step for `npm run build`: tsc emits only .js, so the drizzle
// migrations (.sql + meta/) never reached dist/ and `node dist/src/db/migrate.js`
// (the Docker image's only way to migrate — it has no tsx) found nothing.
// Copies src/db/migrations next to the compiled migrator, then asserts the
// journal and every migration it lists arrived. Plain Node, no dependency.
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'src', 'db', 'migrations');
const dest = join(root, 'dist', 'src', 'db', 'migrations');

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });

const journalPath = join(dest, 'meta', '_journal.json');
if (!existsSync(journalPath)) {
  console.error(`copy-migrations: ${journalPath} is missing after the copy`);
  process.exit(1);
}
const { entries } = JSON.parse(readFileSync(journalPath, 'utf8'));
const missing = entries.map((e) => `${e.tag}.sql`).filter((f) => !existsSync(join(dest, f)));
if (missing.length > 0) {
  console.error(`copy-migrations: journal lists migrations not in dist: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`copy-migrations: ${entries.length} migrations -> dist/src/db/migrations`);

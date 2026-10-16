import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const binSource = join(pkgRoot, 'src', 'bin.ts');

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe('bin entry', () => {
  it('starts when launched through a symlink (as npx / a global install does)', () => {
    // The old entry sniffed process.argv[1] for "index.ts|js"; through the bin
    // symlink argv[1] is the link's own name, so it exited 0 having done nothing.
    // Started for real, with no key it must fail loudly instead.
    tmp = mkdtempSync(join(tmpdir(), 'swil-mcp-bin-'));
    const link = join(tmp, 'swil-mcp');
    symlinkSync(binSource, link);

    const env = { ...process.env };
    delete env.SWIL_API_KEY;
    const out = spawnSync(process.execPath, ['--import', 'tsx', link], {
      cwd: pkgRoot,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/SWIL_API_KEY is missing/);
  });
});

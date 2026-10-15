import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as ingest from '../src/contract/ingest';
import {
  HEADER,
  HEADER_TEXT,
  INGEST_BODIES,
  USAGE,
  addJsSuffixes,
  defaultLayout,
  diffLayout,
  expectedFiles,
  findRepoRoot,
  jsonSchemaFor,
  main,
  type IngestBody,
  type SyncLayout,
} from './contract-sync';

/**
 * The sync script against a throwaway layout (a fake contract, empty client /
 * mcp / agent directories), plus one check of the real repo. Review Focus 3:
 * a hand edit to a generated copy and a deleted source must both make
 * `--check` exit 1 naming the file.
 */

const COMMON = `import { z } from 'zod';\n\nexport const ID_RE = /^[a-f0-9]{24}$/;\nexport const idSchema = z.string().regex(ID_RE);\n`;
const POSTS = `import { z } from 'zod';\nimport { idSchema } from './common';\n\nexport const PostSchema = z.object({ id: idSchema }).strict();\n`;
const ERA = `export const ARM_IDS = ['openai', 'grok'] as const;\n`;

const sample = z.object({
  name: z.string().trim().min(1).max(10),
  hash: z.string().regex(/^[a-f0-9]+$/i),
  vector: z.array(z.number().finite()).length(2),
  count: z.coerce.number().int().min(0).optional().default(0),
  at: z.coerce.date().optional(),
});
const BODIES: IngestBody[] = [
  { name: 'zetaIngest', route: 'POST /zeta', schema: z.object({ ok: z.boolean() }) },
  { name: 'sampleIngest', route: 'POST /sample', schema: sample },
];

let root: string;
let layout: SyncLayout;
const lines: string[] = [];
const out = (line: string) => lines.push(line);
const at = (rel: string) => join(root, rel);
const read = (rel: string) => readFileSync(at(rel), 'utf8');
function write(rel: string, content: string) {
  mkdirSync(dirname(at(rel)), { recursive: true });
  writeFileSync(at(rel), content);
}
/** `main` against the temp layout and the sample bodies (via expectedFiles/diffLayout defaults). */
function run(argv: string[]): number {
  lines.length = 0;
  return main(argv, layout, out, BODIES);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'contract-sync-'));
  layout = defaultLayout(root);
  write('server/src/contract/common.ts', COMMON);
  write('server/src/contract/posts.ts', POSTS);
  write('server/src/contract/lab/era.ts', ERA);
  write('server/src/contract/posts.test.ts', '// a test, never copied\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('contract:sync', () => {
  it('writes the client copies, the mcp subset and one JSON Schema per body', () => {
    expect(run([])).toBe(0);
    expect(
      Object.keys(Object.fromEntries(expectedFiles(layout, BODIES))).map((p) =>
        p.slice(root.length + 1),
      ),
    ).toEqual([
      'client/src/contract/common.ts',
      'client/src/contract/lab/era.ts',
      'client/src/contract/posts.ts',
      'mcp/src/contract/common.ts',
      'agent/tests/contract/sampleIngest.schema.json',
      'agent/tests/contract/zetaIngest.schema.json',
    ]);
    expect(existsSync(at('client/src/contract/posts.test.ts'))).toBe(false);
    expect(existsSync(at('mcp/src/contract/posts.ts'))).toBe(false);
    expect(existsSync(at('mcp/src/contract/lab'))).toBe(false);
    expect(lines.at(-1)).toBe('contract:sync — 6 written, 0 deleted');
  });

  it('prefixes the header and keeps the body byte-identical', () => {
    run([]);
    for (const rel of ['common.ts', 'posts.ts', 'lab/era.ts']) {
      const copy = read(`client/src/contract/${rel}`);
      expect(copy.startsWith(HEADER)).toBe(true);
      expect(copy.slice(HEADER.length)).toBe(read(`server/src/contract/${rel}`));
    }
    expect(HEADER).toBe('// GENERATED from server/src/contract by contract:sync — do not edit.\n');
  });

  it('gives mcp common.ts only, with .js on relative specifiers', () => {
    write('server/src/contract/common.ts', `import { ERA } from './lab/era';\n${COMMON}`);
    run([]);
    expect(read('mcp/src/contract/common.ts')).toBe(
      `${HEADER}import { ERA } from './lab/era.js';\n${COMMON}`,
    );
    // The client resolves extensionless imports: its copy is untouched.
    expect(read('client/src/contract/common.ts')).toBe(
      `${HEADER}import { ERA } from './lab/era';\n${COMMON}`,
    );
  });

  it('is deterministic: a second sync writes nothing and the output is stable', () => {
    run([]);
    const first = expectedFiles(layout, BODIES);
    expect(run([])).toBe(0);
    expect(lines.at(-1)).toBe('contract:sync — 0 written, 0 deleted');
    expect(expectedFiles(layout, BODIES)).toEqual(first);
    for (const body of BODIES) {
      const json = jsonSchemaFor(body);
      expect(json).toBe(jsonSchemaFor(body));
      expect(json).toBe(JSON.stringify(JSON.parse(json), null, 2) + '\n');
    }
  });

  it('deletes an orphan and prunes the emptied directory', () => {
    run([]);
    rmSync(at('server/src/contract/lab/era.ts'));
    expect(run([])).toBe(0);
    expect(lines).toContain('deleted  client/src/contract/lab/era.ts');
    expect(existsSync(at('client/src/contract/lab'))).toBe(false);
  });

  it('leaves a hand-written non-schema file in the agent directory alone', () => {
    run([]);
    write('agent/tests/contract/README.md', 'notes\n');
    // A nested *.schema.json and one without the $comment marker are hand-written too.
    write('agent/tests/contract/fixtures/foo.schema.json', '{}\n');
    write('agent/tests/contract/handIngest.schema.json', '{}\n');
    expect(diffLayout(layout, BODIES)).toEqual({
      stale: [],
      missing: [],
      orphans: [],
      foreign: [],
    });
    run([]);
    expect(read('agent/tests/contract/README.md')).toBe('notes\n');
    expect(read('agent/tests/contract/fixtures/foo.schema.json')).toBe('{}\n');
    expect(read('agent/tests/contract/handIngest.schema.json')).toBe('{}\n');
  });

  it('never deletes a hand-written file in a generated directory: it is foreign', () => {
    run([]);
    write('client/src/contract/helpers.ts', 'export const x = 1;\n');
    write('mcp/src/contract/notes.md', 'notes\n');
    expect(run([])).toBe(0);
    expect(read('client/src/contract/helpers.ts')).toBe('export const x = 1;\n');
    expect(read('mcp/src/contract/notes.md')).toBe('notes\n');
    expect(lines).toContain('foreign  client/src/contract/helpers.ts (left alone; not generated)');
    expect(lines.at(-1)).toBe('contract:sync — 0 written, 0 deleted, 2 foreign left alone');
  });

  it('ignores dotfiles entirely (Finder writes .DS_Store)', () => {
    run([]);
    write('client/src/contract/.DS_Store', 'x');
    write('client/src/contract/lab/.DS_Store', 'x');
    write('mcp/src/contract/.DS_Store', 'x');
    expect(diffLayout(layout, BODIES)).toEqual({
      stale: [],
      missing: [],
      orphans: [],
      foreign: [],
    });
    expect(run([])).toBe(0);
    expect(existsSync(at('client/src/contract/.DS_Store'))).toBe(true);
  });
});

describe('contract:check', () => {
  /** Every file under the temp root with its content — to prove `--check` writes nothing. */
  function snapshot(): Record<string, string> {
    return Object.fromEntries(
      [...expectedFiles(layout, BODIES).keys(), at('client/src/contract/stray.ts')]
        .filter((p) => existsSync(p))
        .map((p) => [p, readFileSync(p, 'utf8')]),
    );
  }

  it('passes on a synced tree', () => {
    run([]);
    expect(run(['--check'])).toBe(0);
    expect(lines).toEqual(['contract:check — in sync (6 generated files)']);
  });

  it('a hand edit to a client copy → exit 1, named as stale', () => {
    run([]);
    write('client/src/contract/posts.ts', `${read('client/src/contract/posts.ts')}// tweak\n`);
    expect(run(['--check'])).toBe(1);
    expect(lines).toContain('stale    client/src/contract/posts.ts');
  });

  it('a deleted source → exit 1, its copy named as an orphan', () => {
    run([]);
    rmSync(at('server/src/contract/posts.ts'));
    expect(run(['--check'])).toBe(1);
    expect(lines).toContain('orphan   client/src/contract/posts.ts');
  });

  it('reports stale JSON, a missing copy, generated orphans and foreign files', () => {
    run([]);
    rmSync(at('mcp/src/contract/common.ts'));
    write('client/src/contract/stray.ts', `${HEADER}export {};\n`);
    write(
      'agent/tests/contract/goneIngest.schema.json',
      `${JSON.stringify({ $comment: HEADER_TEXT })}\n`,
    );
    write('client/src/contract/helpers.ts', 'export {};\n');
    // A changed body, passed locally (never by mutating the shared BODIES).
    const bodies = [
      { ...BODIES[0], schema: z.object({ ok: z.boolean(), extra: z.string() }) },
      BODIES[1],
    ];
    lines.length = 0;
    expect(main(['--check'], layout, out, bodies)).toBe(1);
    expect(lines.slice(0, -1)).toEqual([
      'stale    agent/tests/contract/zetaIngest.schema.json',
      'missing  mcp/src/contract/common.ts',
      'orphan   agent/tests/contract/goneIngest.schema.json',
      'orphan   client/src/contract/stray.ts',
      'foreign  client/src/contract/helpers.ts',
    ]);
    expect(lines.at(-1)).toMatch(
      /5 file\(s\) out of sync; run: npm --prefix server run contract:sync \(foreign files are never deleted/,
    );
  });

  it('a hand edit that drops the header of an expected copy is stale, not foreign', () => {
    run([]);
    write('client/src/contract/posts.ts', POSTS);
    expect(run(['--check'])).toBe(1);
    expect(lines.slice(0, -1)).toEqual(['stale    client/src/contract/posts.ts']);
  });

  it.each([['--chek'], ['--check', '--extra'], ['check']])(
    'refuses unknown arguments %j with usage and exit 2, writing nothing',
    (...argv) => {
      expect(run(argv)).toBe(2);
      expect(lines).toEqual([USAGE]);
      expect(existsSync(at('client/src/contract'))).toBe(false);
    },
  );

  it('writes nothing, even when everything is out of sync', () => {
    run([]);
    write('client/src/contract/posts.ts', 'edited\n');
    write('client/src/contract/stray.ts', 'export {};\n');
    rmSync(at('agent/tests/contract/zetaIngest.schema.json'));
    const before = snapshot();
    expect(run(['--check'])).toBe(1);
    expect(snapshot()).toEqual(before);
  });
});

describe('JSON Schema generation (spec §7.16)', () => {
  const doc = JSON.parse(jsonSchemaFor(BODIES[1])) as {
    $schema: string;
    $comment: string;
    description: string;
    $ref: string;
    definitions: Record<
      string,
      {
        properties: Record<string, Record<string, unknown>>;
        required: string[];
        additionalProperties: boolean;
      }
    >;
  };
  const body = doc.definitions.sampleIngest;

  it('is draft 7, named, inlined, and carries the header in $comment', () => {
    expect(doc.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(doc.$ref).toBe('#/definitions/sampleIngest');
    expect(doc.$comment).toBe(HEADER_TEXT);
    expect(JSON.stringify(doc)).not.toMatch(/"\$ref":"#\/definitions\/sampleIngest\//);
  });

  it('rejects unknown keys, requires coerced fields as their JSON type, applies regex flags', () => {
    expect(body.additionalProperties).toBe(false);
    expect(body.required).toEqual(['name', 'hash', 'vector']);
    expect(body.properties.count).toMatchObject({ type: 'integer', default: 0 });
    expect(body.properties.at).toEqual({ type: 'string', format: 'date-time' });
    expect(body.properties.hash.pattern).toBe('^[a-fA-F0-9]+$');
  });

  it('says where it is stricter than the server', () => {
    expect(doc.description).toContain('POST /sample');
    expect(doc.description).toContain(
      'Stricter than the server on purpose: unknown keys are rejected',
    );
    expect(doc.description).toContain(
      "coerces count with `Number(...)` (numeric strings, booleans → 0/1, `''` → 0, and `null` → 0 unless the field is also nullable)",
    );
    expect(doc.description).toContain(
      'reads at with `new Date(...)` (epoch numbers, naive datetimes',
    );
    expect(doc.description).toContain('`null` → 1970-01-01T00:00:00Z');
  });

  it('says where it is looser: non-finite numbers, Python regex semantics, trimming', () => {
    const looser = doc.description.slice(doc.description.indexOf('Looser than the server'));
    expect(looser).toContain('every number must be finite: NaN and Infinity pass `type: number`');
    expect(looser).toContain('checks vector[] for finiteness explicitly');
    expect(looser).toContain('`pattern` (hash) is ECMA-262');
    expect(looser).toContain('`$` also matches before a trailing newline');
    expect(looser).toContain('`re.fullmatch(..., flags=re.ASCII)`');
    expect(looser).toContain('trims name');
  });

  it('always carries the finiteness note, even without a .finite() field or a pattern', () => {
    const plain = JSON.parse(jsonSchemaFor(BODIES[0])) as { description: string };
    expect(plain.description).toContain('every number must be finite');
    expect(plain.description).not.toContain('`pattern`');
  });
});

describe('the real repo', () => {
  it('lists every ingest body of contract/ingest.ts (aspectDriftIngest is nested, not a body)', () => {
    const exported = Object.keys(ingest)
      .filter((k) => k.endsWith('Ingest'))
      .filter((k) => k !== 'aspectDriftIngest')
      .sort();
    expect(INGEST_BODIES.map((b) => b.name).sort()).toEqual(exported);
    for (const b of INGEST_BODIES) {
      expect(b.schema).toBe(ingest[b.name as keyof typeof ingest]);
    }
  });

  it('has every generated file in sync with server/src/contract (run contract:sync)', () => {
    const real = defaultLayout();
    expect(diffLayout(real)).toEqual({ stale: [], missing: [], orphans: [], foreign: [] });
    expect(
      [...expectedFiles(real).keys()].some((p) => p.endsWith('mcp/src/contract/common.ts')),
    ).toBe(true);
  });
});

describe('findRepoRoot', () => {
  it('finds the root from the script directory and from a compiled dist/scripts', () => {
    const repo = join(__dirname, '..', '..');
    expect(findRepoRoot(__dirname)).toBe(repo);
    expect(findRepoRoot(join(__dirname, '..', 'dist', 'scripts'))).toBe(repo);
  });

  it('throws when no ancestor holds server/src/contract', () => {
    expect(() => findRepoRoot(tmpdir())).toThrow(/no server\/src\/contract/);
  });
});

describe('addJsSuffixes', () => {
  it('adds .js to relative specifiers only', () => {
    const src = [
      "import { z } from 'zod';",
      "import { a } from './common';",
      "import type { B } from '../lab/era';",
      "export * from './posts';",
      'export { c } from "./users";',
      "import './side';",
      "const m = import('./lazy');",
      "import { d } from './already.js';",
    ].join('\n');
    expect(addJsSuffixes(src)).toBe(
      [
        "import { z } from 'zod';",
        "import { a } from './common.js';",
        "import type { B } from '../lab/era.js';",
        "export * from './posts.js';",
        'export { c } from "./users.js";',
        "import './side.js';",
        "const m = import('./lazy.js');",
        "import { d } from './already.js';",
      ].join('\n'),
    );
  });
});

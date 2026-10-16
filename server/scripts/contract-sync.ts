/**
 * contract:sync — distribute `server/src/contract/` to the packages that cannot
 * import it (spec §3.3, §7.14–§7.19).
 *
 *   npm --prefix server run contract:sync    write every generated file
 *   npm --prefix server run contract:check   write nothing; list every stale,
 *                                            missing or orphaned file; exit 1
 *
 * What it writes:
 *
 * - `client/src/contract/**` — every non-test `.ts` of the contract, same
 *   subpaths, the header line followed by the source byte for byte (the source
 *   is already Prettier-formatted; the client resolves extensionless imports).
 * - `mcp/src/contract/{common,limits}.ts` — the only files mcp needs,
 *   with relative specifiers given a `.js` suffix for Node16 ESM.
 * - `agent/tests/contract/<name>.schema.json` — a JSON Schema (draft 7) per
 *   agent ingest body, for the agent's pytest. JSON has no comments, so the
 *   header rides in `$comment`, and `description` says where the schema is
 *   stricter than the server and what it cannot express.
 *
 * A file counts as generated only if it carries the marker: a `.ts` whose first
 * line is the header, a `.schema.json` whose `$comment` is the header text.
 * Every generated file whose source is gone is deleted (`sync`) or reported
 * (`--check`). Any other file in the client / mcp contract directories is
 * `foreign`: reported by `--check` (exit 1), never deleted. Dotfiles
 * (`.DS_Store`) are ignored. Output is deterministic: sorted file lists,
 * `JSON.stringify(x, null, 2) + '\n'`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  agentEventIngest,
  behaviorSnapshotIngest,
  benchmarkRunIngest,
  postVectorIngest,
  snapshotIngest,
} from '../src/contract/ingest';

export const HEADER_TEXT = 'GENERATED from server/src/contract by contract:sync — do not edit.';
export const HEADER = `// ${HEADER_TEXT}\n`;

/** The only contract file mcp receives (spec §7.14). */
export const MCP_FILES = ['common.ts', 'limits.ts'] as const;

export interface IngestBody {
  /** Export name in `contract/ingest.ts`; also the JSON file's base name. */
  name: string;
  /** The endpoint that takes this body, for the schema's description. */
  route: string;
  schema: z.ZodTypeAny;
}

/**
 * Every request body the agent POSTs. `aspectDriftIngest` is not a body of its
 * own (it is nested in `snapshotIngest`), and `POST /agents/population-metric`
 * has no body (spec §7.5). `contract-sync.test.ts` pins this list to the
 * `…Ingest` exports of `contract/ingest.ts`.
 */
export const INGEST_BODIES: readonly IngestBody[] = [
  {
    name: 'agentEventIngest',
    route: 'POST /api/v1/agents/:username/events',
    schema: agentEventIngest,
  },
  {
    name: 'behaviorSnapshotIngest',
    route: 'POST /api/v1/agents/:username/behavior-snapshots',
    schema: behaviorSnapshotIngest,
  },
  {
    name: 'benchmarkRunIngest',
    route: 'POST /api/v1/agents/benchmark/runs',
    schema: benchmarkRunIngest,
  },
  {
    name: 'postVectorIngest',
    route: 'POST /api/v1/agents/:username/post-vectors',
    schema: postVectorIngest,
  },
  {
    name: 'snapshotIngest',
    route: 'POST /api/v1/agents/:username/snapshots',
    schema: snapshotIngest,
  },
];

export interface SyncLayout {
  /** Repo root; reported paths are relative to it. */
  root: string;
  contractDir: string;
  clientDir: string;
  mcpDir: string;
  agentDir: string;
}

/**
 * The repo root: the nearest ancestor of `start` holding `server/src/contract`.
 * Searched rather than fixed at `../..` so the compiled copy the server build
 * emits (`dist/scripts/contract-sync.js`) cannot write into `server/` itself.
 */
export function findRepoRoot(start = __dirname): string {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'server', 'src', 'contract'))) return dir;
    if (dirname(dir) === dir) throw new Error(`no server/src/contract above ${start}`);
  }
}

export function defaultLayout(root = findRepoRoot()): SyncLayout {
  return {
    root,
    contractDir: join(root, 'server', 'src', 'contract'),
    clientDir: join(root, 'client', 'src', 'contract'),
    mcpDir: join(root, 'mcp', 'src', 'contract'),
    agentDir: join(root, 'agent', 'tests', 'contract'),
  };
}

const toPosix = (p: string) => p.split(sep).join('/');

/**
 * Every file under `dir` (recursive), as sorted posix paths relative to `dir`.
 * Dotfiles and dot-directories (`.DS_Store`) are skipped: no tool here writes
 * one, and Finder does.
 */
function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (sub: string) => {
    for (const entry of readdirSync(join(dir, sub), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else out.push(rel);
    }
  };
  walk('');
  return out.sort();
}

/** The contract sources the copies are made from: non-test `.ts`, sorted. */
export function contractSources(contractDir: string): string[] {
  return listFiles(contractDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
}

/** The client copy: the header line, then the source unchanged. */
export function toClientCopy(source: string): string {
  return HEADER + source;
}

/** Give every relative import / export specifier a `.js` suffix (Node16 ESM). */
export function addJsSuffixes(source: string): string {
  return source.replace(
    /(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+?)\2/g,
    (match, lead: string, quote: string, spec: string) =>
      spec.endsWith('.js') ? match : `${lead}${quote}${spec}.js${quote}`,
  );
}

/** The mcp copy: the header line, then the source with `.js` relative specifiers. */
export function toMcpCopy(source: string): string {
  return HEADER + addJsSuffixes(source);
}

/** The options of spec §7.16, verbatim. */
function jsonSchemaOptions(name: string) {
  return {
    name,
    target: 'jsonSchema7',
    $refStrategy: 'none',
    effectStrategy: 'input',
    dateStrategy: 'format:date-time',
    applyRegexFlags: true,
  } as const;
}

interface Limitations {
  trimmed: string[];
  patterns: string[];
  finite: string[];
  coercedNumbers: string[];
  coercedDates: string[];
}

function unwrap(t: z.ZodTypeAny): z.ZodTypeAny {
  for (;;) {
    if (t instanceof z.ZodOptional || t instanceof z.ZodNullable) t = t.unwrap();
    else if (t instanceof z.ZodDefault) t = t.removeDefault();
    else if (t instanceof z.ZodEffects) t = t.innerType();
    else return t;
  }
}

/** Collect the field paths whose zod rules JSON Schema cannot carry. */
function collectLimitations(t: z.ZodTypeAny, path: string, acc: Limitations): Limitations {
  const u = unwrap(t);
  if (u instanceof z.ZodObject) {
    const shape = u.shape as z.ZodRawShape;
    for (const key of Object.keys(shape)) {
      collectLimitations(shape[key], path ? `${path}.${key}` : key, acc);
    }
  } else if (u instanceof z.ZodArray) {
    collectLimitations(u.element, `${path}[]`, acc);
  } else if (u instanceof z.ZodRecord) {
    collectLimitations(u.valueSchema, `${path}.*`, acc);
  } else if (u instanceof z.ZodString) {
    if (u._def.checks.some((c) => c.kind === 'trim')) acc.trimmed.push(path);
    if (u._def.checks.some((c) => c.kind === 'regex')) acc.patterns.push(path);
  } else if (u instanceof z.ZodNumber) {
    if (u._def.checks.some((c) => c.kind === 'finite')) acc.finite.push(path);
    if (u._def.coerce) acc.coercedNumbers.push(path);
  } else if (u instanceof z.ZodDate) {
    if (u._def.coerce) acc.coercedDates.push(path);
  }
  return acc;
}

/**
 * The generated schema's `description`: where it is stricter than the server,
 * and where it is looser (what JSON Schema cannot say, and what a Python
 * validator reads differently), so the agent's test can assert those directly.
 */
export function describeBody(body: IngestBody): string {
  const lim = collectLimitations(body.schema, '', {
    trimmed: [],
    patterns: [],
    finite: [],
    coercedNumbers: [],
    coercedDates: [],
  });
  const stricter = [
    'unknown keys are rejected here, where the server strips them, so a misspelt field fails a test instead of being dropped',
  ];
  if (lim.coercedNumbers.length) {
    stricter.push(
      `the server coerces ${lim.coercedNumbers.join(', ')} with \`Number(...)\` (numeric strings, booleans → 0/1, \`''\` → 0, and \`null\` → 0 unless the field is also nullable), while this schema requires a JSON number`,
    );
  }
  if (lim.coercedDates.length) {
    stricter.push(
      `the server reads ${lim.coercedDates.join(', ')} with \`new Date(...)\` (epoch numbers, naive datetimes read in the server's own time zone, \`null\` → 1970-01-01T00:00:00Z), while this schema requires an RFC 3339 date-time string with an offset (\`format: date-time\`, checked only by a validator with a format checker)`,
    );
  }
  const looser = [
    `every number must be finite: NaN and Infinity pass \`type: number\` and every minimum/maximum here, but JSON cannot carry them (httpx raises before sending, the server's parser rejects them)${lim.finite.length ? `, and the server also checks ${lim.finite.join(', ')} for finiteness explicitly` : ''}`,
  ];
  if (lim.patterns.length) {
    looser.push(
      `\`pattern\` (${lim.patterns.join(', ')}) is ECMA-262, but a Python validator evaluates it with \`re.search\`, where \`$\` also matches before a trailing newline and \`\\d\` matches non-ASCII digits, so check those fields with \`re.fullmatch(..., flags=re.ASCII)\``,
    );
  }
  if (lim.trimmed.length) {
    looser.push(
      `the server trims ${lim.trimmed.join(', ')} before checking their length bounds, while this schema checks the untrimmed length, so a whitespace-only value passes a minLength the server would fail`,
    );
  }
  return [
    `Request body of ${body.route} (zod source: \`${body.name}\` in server/src/contract/ingest.ts).`,
    `Stricter than the server on purpose: ${stricter.join('; ')}.`,
    `Looser than the server, so the agent's test asserts these directly: ${looser.join('; ')}.`,
  ].join(' ');
}

/** One body's JSON Schema file content. */
export function jsonSchemaFor(body: IngestBody): string {
  // Typed loosely on purpose: the library types its parameter against `zod/v3`,
  // which this tsconfig's Node10 resolution reaches as a separate declaration of
  // the same classes, and comparing the two structurally trips TS2589. That
  // subpath exists only from zod 3.25 (the library's peer is ^3.25.28 || ^4);
  // package.json still declares zod ^3.23.8 (kept for S4), so the lockfile's
  // 3.25.76 is what guarantees it.
  const convert = zodToJsonSchema as unknown as (schema: unknown, options: object) => unknown;
  const generated = convert(body.schema, jsonSchemaOptions(body.name)) as Record<string, unknown>;
  const { $schema, ...rest } = generated;
  const doc = { $schema, $comment: HEADER_TEXT, description: describeBody(body), ...rest };
  return JSON.stringify(doc, null, 2) + '\n';
}

/** Every generated file and its content, keyed by absolute path, in sorted order. */
export function expectedFiles(
  layout: SyncLayout,
  bodies: readonly IngestBody[] = INGEST_BODIES,
): Map<string, string> {
  const out = new Map<string, string>();
  const sources = contractSources(layout.contractDir);
  for (const rel of sources) {
    const source = readFileSync(join(layout.contractDir, rel), 'utf8');
    out.set(join(layout.clientDir, rel), toClientCopy(source));
  }
  for (const rel of MCP_FILES) {
    if (!sources.includes(rel)) continue;
    const source = readFileSync(join(layout.contractDir, rel), 'utf8');
    out.set(join(layout.mcpDir, rel), toMcpCopy(source));
  }
  for (const body of [...bodies].sort((a, b) => a.name.localeCompare(b.name))) {
    out.set(join(layout.agentDir, `${body.name}.schema.json`), jsonSchemaFor(body));
  }
  return out;
}

/** A `.ts` whose first line is the header. */
function isGeneratedTs(path: string): boolean {
  return readFileSync(path, 'utf8').startsWith(HEADER);
}

/** A `.schema.json` whose `$comment` is the header text. */
function isGeneratedJson(path: string): boolean {
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as { $comment?: unknown };
    return doc.$comment === HEADER_TEXT;
  } catch {
    return false;
  }
}

/**
 * The files present now, split into generated (they carry the marker) and
 * foreign (anything else in the client / mcp contract directories). In the
 * agent directory only top-level `*.schema.json` files are looked at; any
 * other file there is hand-written and simply not the sync's business.
 */
export function presentFiles(layout: SyncLayout): { generated: string[]; foreign: string[] } {
  const generated: string[] = [];
  const foreign: string[] = [];
  for (const dir of [layout.clientDir, layout.mcpDir]) {
    for (const rel of listFiles(dir)) {
      const path = join(dir, rel);
      (rel.endsWith('.ts') && isGeneratedTs(path) ? generated : foreign).push(path);
    }
  }
  for (const rel of listFiles(layout.agentDir)) {
    const path = join(layout.agentDir, rel);
    if (!rel.includes('/') && rel.endsWith('.schema.json') && isGeneratedJson(path)) {
      generated.push(path);
    }
  }
  return { generated: generated.sort(), foreign: foreign.sort() };
}

export interface SyncDiff {
  /** Exists with different content. */
  stale: string[];
  /** Expected, absent. */
  missing: string[];
  /** Generated (carries the marker), no longer expected: its source is gone. */
  orphans: string[];
  /** Not generated and not expected, in a generated directory: never deleted. */
  foreign: string[];
}

export function diffLayout(
  layout: SyncLayout,
  bodies: readonly IngestBody[] = INGEST_BODIES,
): SyncDiff {
  const expected = expectedFiles(layout, bodies);
  const stale: string[] = [];
  const missing: string[] = [];
  for (const [path, content] of expected) {
    if (!existsSync(path)) missing.push(path);
    else if (readFileSync(path, 'utf8') !== content) stale.push(path);
  }
  const present = presentFiles(layout);
  return {
    stale: stale.sort(),
    missing: missing.sort(),
    orphans: present.generated.filter((p) => !expected.has(p)),
    // A hand edit that dropped the header from an expected path is stale, not foreign.
    foreign: present.foreign.filter((p) => !expected.has(p)),
  };
}

/** Remove now-empty directories under `dir` (never `dir` itself). */
function pruneEmptyDirs(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sub = join(dir, entry.name);
    pruneEmptyDirs(sub);
    if (readdirSync(sub).length === 0) rmSync(sub, { recursive: true });
  }
}

/** Write every stale or missing file and delete every orphan; foreign files are left alone. */
export function syncLayout(
  layout: SyncLayout,
  bodies: readonly IngestBody[] = INGEST_BODIES,
): { written: string[]; deleted: string[]; foreign: string[] } {
  const { stale, missing, orphans, foreign } = diffLayout(layout, bodies);
  const expected = expectedFiles(layout, bodies);
  const written = [...missing, ...stale].sort();
  for (const path of written) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, expected.get(path) as string);
  }
  for (const path of orphans) rmSync(path);
  for (const dir of [layout.clientDir, layout.mcpDir]) pruneEmptyDirs(dir);
  return { written, deleted: orphans, foreign };
}

export const USAGE = 'usage: tsx scripts/contract-sync.ts [--check]';

/** CLI entry. Returns the exit code: 0 ok, 1 out of sync (`--check`), 2 bad arguments. */
export function main(
  argv: readonly string[],
  layout: SyncLayout = defaultLayout(),
  out: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  bodies: readonly IngestBody[] = INGEST_BODIES,
): number {
  const rel = (p: string) => toPosix(relative(layout.root, p));
  // Anything but no flag or exactly `--check` is refused: a typo such as
  // `--chek` must not fall through to a run that writes and deletes.
  const check = argv.length === 1 && argv[0] === '--check';
  if (!check && argv.length > 0) {
    out(USAGE);
    return 2;
  }
  if (check) {
    const { stale, missing, orphans, foreign } = diffLayout(layout, bodies);
    const lines = [
      ...stale.map((p) => `stale    ${rel(p)}`),
      ...missing.map((p) => `missing  ${rel(p)}`),
      ...orphans.map((p) => `orphan   ${rel(p)}`),
      ...foreign.map((p) => `foreign  ${rel(p)}`),
    ];
    if (lines.length === 0) {
      out(`contract:check — in sync (${expectedFiles(layout, bodies).size} generated files)`);
      return 0;
    }
    for (const line of lines) out(line);
    out(
      `contract:check — ${lines.length} file(s) out of sync; run: npm --prefix server run contract:sync` +
        (foreign.length ? ' (foreign files are never deleted: move or remove them by hand)' : ''),
    );
    return 1;
  }
  const { written, deleted, foreign } = syncLayout(layout, bodies);
  for (const p of written) out(`wrote    ${rel(p)}`);
  for (const p of deleted) out(`deleted  ${rel(p)}`);
  for (const p of foreign) out(`foreign  ${rel(p)} (left alone; not generated)`);
  out(
    `contract:sync — ${written.length} written, ${deleted.length} deleted` +
      (foreign.length ? `, ${foreign.length} foreign left alone` : ''),
  );
  return 0;
}

// Run only as a script (`tsx scripts/contract-sync.ts`), never on import from a test.
if (/contract-sync\.[jt]s$/.test(process.argv[1] ?? '')) {
  process.exitCode = main(process.argv.slice(2));
}

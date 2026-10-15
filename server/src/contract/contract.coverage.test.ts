import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every exported `…Schema` in the contract must be parsed against real data in
 * at least one server test: `expectContract(<Name>` somewhere in a `*.test.ts`
 * under `server/src` (spec §7.7). An import alone does not count — a schema
 * nothing parses records a shape nobody checked.
 */

const CONTRACT_DIR = __dirname;
const SRC_DIR = join(__dirname, '..');
const THIS_FILE = __filename;

function walk(dir: string, keep: (name: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : walk(full, keep);
    return keep(name) ? [full] : [];
  });
}

/** Names of the `export const <Name>Schema` declarations in one contract source. */
function exportedSchemaNames(source: string): string[] {
  return [...source.matchAll(/^export const (\w+Schema)\b/gm)].map((m) => m[1]);
}

/**
 * Drop `//` and block comments so a commented-out call does not count. Good
 * enough for test sources; a `//` inside a string literal (a URL) only ever
 * drops the rest of that line, which can make the check stricter, never looser.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * The schema names no test source parses with `expectContract(<Name>, …)`:
 * the schema itself must be the whole first argument, so a derivation such as
 * `<Name>.partial()` or `<Name>.extend(…)` does not cover it.
 */
function unreferenced(names: string[], testSources: string[]): string[] {
  const sources = testSources.map(stripComments);
  return names.filter((name) => {
    const call = new RegExp(`expectContract\\(\\s*${name}\\s*,`);
    return !sources.some((src) => call.test(src));
  });
}

describe('contract coverage', () => {
  const contractFiles = walk(
    CONTRACT_DIR,
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
  );
  const schemaNames = contractFiles.flatMap((f) => exportedSchemaNames(readFileSync(f, 'utf8')));
  const testSources = walk(SRC_DIR, (name) => name.endsWith('.test.ts'))
    .filter((f) => f !== THIS_FILE)
    .map((f) => readFileSync(f, 'utf8'));

  it('finds the contract schemas and the server tests', () => {
    const names = contractFiles.map((f) => relative(CONTRACT_DIR, f));
    expect(names).toEqual(
      expect.arrayContaining([
        'common.ts',
        'users.ts',
        'posts.ts',
        'messaging.ts',
        'ingest.ts',
        join('lab', 'era.ts'),
        join('lab', 'population.ts'),
        join('lab', 'persona.ts'),
        join('lab', 'runtime.ts'),
        join('lab', 'bench.ts'),
        join('lab', 'arms.ts'),
      ]),
    );
    expect(schemaNames).toEqual(
      expect.arrayContaining([
        'UserDTOSchema',
        'PostDTOSchema',
        'NotificationDTOSchema',
        'ArmsReportDTOSchema',
        'AgentEventIngestResultSchema',
      ]),
    );
    expect(testSources.length).toBeGreaterThan(50);
  });

  it('every exported schema is parsed by expectContract in some server test', () => {
    expect(unreferenced(schemaNames, testSources)).toEqual([]);
  });

  it('can fail: only a live call with the schema as its whole first argument counts', () => {
    const sources = [
      "import { NeverParsedSchema, ParsedSchema } from '../contract/posts';",
      'const s = NeverParsedSchema; // mentioned, never parsed',
      'expectContract(ParsedSchema, value);',
      'expectContract(\n  WrappedSchema,\n  value,\n);',
      'expectContract(envelope(z.object({ post: NestedSchema })), body);',
      'expectContract(ParsedSchemaTwin, value);',
      '// expectContract(LineCommentedSchema, value);',
      '/* expectContract(BlockCommentedSchema, value); */',
      'expectContract(DerivedSchema.partial(), value);',
      'expectContract(ExtendedSchema.extend({ x: z.string() }), value);',
    ];
    expect(
      unreferenced(
        [
          'NeverParsedSchema',
          'ParsedSchema',
          'WrappedSchema',
          'NestedSchema',
          'ParsedSchemaT',
          'LineCommentedSchema',
          'BlockCommentedSchema',
          'DerivedSchema',
          'ExtendedSchema',
        ],
        sources,
      ),
    ).toEqual([
      'NeverParsedSchema',
      'NestedSchema',
      'ParsedSchemaT',
      'LineCommentedSchema',
      'BlockCommentedSchema',
      'DerivedSchema',
      'ExtendedSchema',
    ]);
  });

  it('can fail: reads export names from a contract source', () => {
    const source = [
      'export const FooDTOSchema = z.object({}).strict();',
      'export type FooDTO = z.infer<typeof FooDTOSchema>;',
      'const innerSchema = z.string();',
      'export const LIMITS = { a: 1 };',
      'export function envelope() {}',
      'export const barSchema = z.enum(BARS);',
    ].join('\n');
    expect(exportedSchemaNames(source)).toEqual(['FooDTOSchema', 'barSchema']);
  });
});

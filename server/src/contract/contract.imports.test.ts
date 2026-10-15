import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The authoritative import rule for `src/contract/` (the ESLint rule is only a
 * hint): a contract file may import `zod` and other contract FILES, nothing
 * else. The directory is copied verbatim to the client and mcp, whose builds
 * never see the rest of the server, and the mcp copy only appends `.js` to a
 * specifier — so a directory import (`./lab`) would break there.
 */

const CONTRACT_DIR = __dirname;

function contractSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return contractSources(full);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : [];
  });
}

/** Every module specifier in `source` — static, type-only, re-export, require, dynamic import. */
function specifiersOf(source: string): string[] {
  return ts.preProcessFile(source, true, true).importedFiles.map((f) => f.fileName);
}

/** Violations for one file; empty when it obeys the rule. */
function importViolations(file: string, source: string, root = CONTRACT_DIR): string[] {
  const where = relative(root, file) || file;
  return specifiersOf(source).flatMap((spec): string[] => {
    if (spec === 'zod') return [];
    if (!spec.startsWith('./') && !spec.startsWith('../')) {
      return [`${where}: '${spec}' is a package other than zod`];
    }
    const target = resolve(dirname(file), spec);
    if (target !== root && !target.startsWith(root + sep)) {
      return [`${where}: '${spec}' leaves src/contract/`];
    }
    if (/\.[cm]?[jt]s$/.test(spec)) {
      return [`${where}: '${spec}' carries an extension (sync adds .js for mcp)`];
    }
    if (existsSync(target) && statSync(target).isDirectory()) {
      return [`${where}: '${spec}' is a directory import — name the file`];
    }
    if (!existsSync(`${target}.ts`)) {
      return [`${where}: '${spec}' does not resolve to a contract file`];
    }
    return [];
  });
}

describe('contract imports', () => {
  it('finds the contract sources', () => {
    const names = contractSources(CONTRACT_DIR).map((f) => relative(CONTRACT_DIR, f));
    expect(names).toEqual(expect.arrayContaining(['common.ts', 'index.ts', join('lab', 'era.ts')]));
  });

  it('every contract file imports only zod and sibling contract files', () => {
    const violations = contractSources(CONTRACT_DIR).flatMap((file) =>
      importViolations(file, readFileSync(file, 'utf8')),
    );
    expect(violations).toEqual([]);
  });

  describe('the checker can fail', () => {
    const file = join(CONTRACT_DIR, 'lab', 'example.ts');
    const check = (source: string) => importViolations(file, source);

    it('accepts zod and sibling files', () => {
      expect(
        check(
          "import { z } from 'zod';\nimport { LOCALES } from '../common';\nexport * from './era';",
        ),
      ).toEqual([]);
    });

    it.each([
      ["import { AppError } from '../../lib/errors';", 'leaves src/contract/'],
      ["import type { PostRow } from '../../lib/dto';", 'leaves src/contract/'],
      ["import express from 'express';", 'a package other than zod'],
      ["import { x } from '@/contract';", 'a package other than zod'],
      ["export * from '../lab';", 'directory import'],
      ["export * from './missing';", 'does not resolve'],
      ["import { ARM_IDS } from './era.js';", 'carries an extension'],
      ["const fs = require('fs');", 'a package other than zod'],
      ["const m = await import('../../config/env');", 'leaves src/contract/'],
    ])('rejects %s', (source, reason) => {
      const out = check(source);
      expect(out).toHaveLength(1);
      expect(out[0]).toContain(reason);
    });
  });
});

/** en and zh must carry exactly the same keys, so no string falls back silently. */
import { describe, expect, it } from 'vitest';
import en from './en.json';
import zh from './zh.json';

function flatKeys(node: unknown, prefix = ''): string[] {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return [prefix];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
    flatKeys(v, prefix ? `${prefix}.${k}` : k),
  );
}

describe('locales', () => {
  it('en.json and zh.json have identical flattened key sets', () => {
    const enKeys = new Set(flatKeys(en));
    const zhKeys = new Set(flatKeys(zh));
    expect([...enKeys].filter((k) => !zhKeys.has(k))).toEqual([]);
    expect([...zhKeys].filter((k) => !enKeys.has(k))).toEqual([]);
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EnvSchema } from './env';

/**
 * `.env.example` is the only list of server settings a new deploy reads, and it
 * drifted from the schema both ways (AWS_S3_BUCKET missing from the docs side,
 * CACHE_TTL kept on both long after nothing read it). Keys may be live
 * (`KEY=`) or commented-out (`# KEY=`) examples.
 */
const example = fs.readFileSync(path.resolve(__dirname, '../../.env.example'), 'utf8');
const exampleKeys = new Set(
  [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1] as string),
);
const schemaKeys = Object.keys(EnvSchema.shape);

describe('server/.env.example', () => {
  it('documents every EnvSchema key', () => {
    expect(schemaKeys.filter((k) => !exampleKeys.has(k))).toEqual([]);
  });

  it('lists no key the schema does not read', () => {
    expect([...exampleKeys].filter((k) => !schemaKeys.includes(k))).toEqual([]);
  });
});

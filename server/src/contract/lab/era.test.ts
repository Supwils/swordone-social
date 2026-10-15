import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { expectContract } from '../../test/contract';
import {
  ARM_IDS,
  LAB_COHORTS,
  LAB_ERAS,
  LAB_RANGES,
  armIdSchema,
  armRecord,
  labCohortSchema,
  labEraSchema,
  labRangeSchema,
} from './era';

describe('lab enums', () => {
  it('pins the values', () => {
    expect(LAB_ERAS).toEqual([2, 3]);
    expect(LAB_COHORTS).toEqual(['first-party', 'community', 'human']);
    expect(ARM_IDS).toEqual(['openai', 'grok', 'gemini', 'claude-opus', 'claude-haiku']);
    expect(LAB_RANGES).toEqual(['7d', '30d', '90d']);
  });

  it('accepts every value and rejects others', () => {
    for (const era of LAB_ERAS) expect(expectContract(labEraSchema, era)).toBe(era);
    for (const c of LAB_COHORTS) expect(expectContract(labCohortSchema, c)).toBe(c);
    for (const a of ARM_IDS) expect(expectContract(armIdSchema, a)).toBe(a);
    for (const r of LAB_RANGES) expect(expectContract(labRangeSchema, r)).toBe(r);

    expect(() => expectContract(labEraSchema, 1)).toThrow('<root>');
    expect(() => expectContract(labEraSchema, '3')).toThrow('<root>');
    expect(() => expectContract(labCohortSchema, 'bot')).toThrow('<root>');
    expect(() => expectContract(armIdSchema, 'claude')).toThrow('<root>');
    expect(() => expectContract(labRangeSchema, '1y')).toThrow('<root>');
  });
});

describe('armRecord', () => {
  const schema = armRecord(z.number());
  const full = { openai: 1, grok: 2, gemini: 3, 'claude-opus': 4, 'claude-haiku': 5 };

  it('has exactly the ARM_IDS keys', () => {
    expect(Object.keys(schema.shape).sort()).toEqual([...ARM_IDS].sort());
  });

  it('accepts a record with every arm', () => {
    expect(expectContract(schema, full)).toEqual(full);
  });

  it('rejects a missing arm, naming it', () => {
    const { gemini: _gemini, ...missing } = full;
    expect(() => expectContract(schema, missing)).toThrow('gemini: Required');
  });

  it('rejects an extra key', () => {
    expect(() => expectContract(schema, { ...full, deepseek: 6 })).toThrow("'deepseek'");
  });

  it('checks every value with the inner schema', () => {
    expect(() => expectContract(schema, { ...full, grok: 'x' })).toThrow('grok:');
  });
});

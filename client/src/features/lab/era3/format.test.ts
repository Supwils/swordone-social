import { describe, expect, it } from 'vitest';
import { buildChartRows, describeVerdict, fmtNum, fmtPct, fmtRatio, metricFormat } from './format';
import { emptyReport, seededReport } from './testFixtures';

describe('era3 number formatting', () => {
  it('prints 3 decimals, percentages and ratios, and an em dash for null or non-finite', () => {
    expect(fmtNum(0.12345)).toBe('0.123');
    expect(fmtNum(-0.0121)).toBe('-0.012');
    expect(fmtNum(null)).toBe('—');
    expect(fmtNum(Number.NaN)).toBe('—');
    expect(fmtPct(0.0667)).toBe('6.7%');
    expect(fmtPct(null)).toBe('—');
    expect(fmtRatio(1.216)).toBe('1.22×');
    expect(fmtRatio(null)).toBe('—');
  });

  it('formats repetition as a share and the slope metrics as similarities', () => {
    expect(metricFormat('repetition')(0.175)).toBe('17.5%');
    expect(metricFormat('fidelity')(0.175)).toBe('0.175');
    expect(metricFormat('convergence')(null)).toBe('—');
  });
});

describe('buildChartRows', () => {
  it('pivots arm series and the population line into one row per sweep ordinal', () => {
    const rows = buildChartRows(seededReport().metrics.convergence);
    expect(rows.map((r) => r.ordinal)).toEqual([1, 2, 3]);
    expect(rows[0].roundId).toBe('20261015T060000Z-r');
    expect(rows[0].openai).toBeCloseTo(0.6);
    expect(rows[1].gemini).toBeNull();
    expect(rows[2].population).toBeCloseTo(0.624);
  });

  it('returns no rows for a zero-round block', () => {
    expect(buildChartRows(emptyReport().metrics.fidelity)).toEqual([]);
  });
});

describe('describeVerdict', () => {
  const v = (
    status: 'collecting' | 'differs' | 'no-difference' | 'insufficient',
    frozen: boolean,
  ) => ({
    status,
    between: 0.02,
    within: 0.01,
    frozenAt: frozen ? '20261101T060000Z-r' : null,
  });

  it('reads every verdict as provisional until the window is frozen', () => {
    expect(describeVerdict(v('differs', false)).kind).toBe('provisional');
    expect(describeVerdict(v('insufficient', false)).kind).toBe('provisional');
  });

  it('maps frozen statuses to their own wording and tone', () => {
    expect(describeVerdict(v('differs', true))).toEqual({ kind: 'differs', tone: 'good' });
    expect(describeVerdict(v('no-difference', true))).toEqual({
      kind: 'noDifference',
      tone: 'neutral',
    });
    expect(describeVerdict(v('insufficient', true))).toEqual({
      kind: 'insufficient',
      tone: 'warn',
    });
    expect(describeVerdict(v('collecting', true))).toEqual({ kind: 'collecting', tone: 'neutral' });
  });
});

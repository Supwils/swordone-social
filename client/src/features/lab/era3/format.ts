/** Pure helpers for the Era 3 dashboard: number formatting, chart rows, verdict wording. */
import type { ArmId, MetricBlock, Verdict } from '@/features/lab/types';
import { ARM_IDS } from './armColors';

const DASH = '—';

const finite = (v: number | null | undefined): v is number =>
  typeof v === 'number' && Number.isFinite(v);

/** Similarities, slopes and SDs: 3 decimals. */
export function fmtNum(v: number | null | undefined, digits = 3): string {
  return finite(v) ? v.toFixed(digits) : DASH;
}

/** Shares and rates: a percentage with one decimal. */
export function fmtPct(v: number | null | undefined): string {
  return finite(v) ? `${(v * 100).toFixed(1)}%` : DASH;
}

/** Observed ÷ expected. */
export function fmtRatio(v: number | null | undefined): string {
  return finite(v) ? `${v.toFixed(2)}×` : DASH;
}

/** (b) is a share of candidates; (a) and (c) are similarities and their slopes. */
export function metricFormat(key: MetricBlock['key']): (v: number | null | undefined) => string {
  return key === 'repetition' ? fmtPct : (v) => fmtNum(v);
}

export type ChartRow = { ordinal: number; roundId: string; population: number | null } & Record<
  ArmId,
  number | null
>;

/** One row per sweep ordinal: each arm's value plus the population line (convergence only). */
export function buildChartRows(block: MetricBlock): ChartRow[] {
  const rows = new Map<number, ChartRow>();
  const rowAt = (ordinal: number, roundId: string): ChartRow => {
    let row = rows.get(ordinal);
    if (!row) {
      row = {
        ordinal,
        roundId,
        population: null,
        openai: null,
        grok: null,
        gemini: null,
        'claude-opus': null,
        'claude-haiku': null,
      };
      rows.set(ordinal, row);
    }
    return row;
  };
  for (const s of block.series) {
    if (!ARM_IDS.includes(s.arm)) continue;
    for (const p of s.points) rowAt(p.ordinal, p.roundId)[s.arm] = finite(p.value) ? p.value : null;
  }
  for (const p of block.population ?? []) {
    rowAt(p.ordinal, p.roundId).population = finite(p.value) ? p.value : null;
  }
  return [...rows.values()].sort((a, b) => a.ordinal - b.ordinal);
}

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';
export type VerdictKind =
  | 'provisional'
  | 'collecting'
  | 'insufficient'
  | 'differs'
  | 'noDifference';

/**
 * Wording for a verdict. Before the window freezes (12th completed round) every
 * value is provisional whatever the server's status, per the decision rule.
 */
export function describeVerdict(v: Verdict): { kind: VerdictKind; tone: Tone } {
  if (v.frozenAt === null) return { kind: 'provisional', tone: 'neutral' };
  switch (v.status) {
    case 'differs':
      return { kind: 'differs', tone: 'good' };
    case 'no-difference':
      return { kind: 'noDifference', tone: 'neutral' };
    case 'insufficient':
      return { kind: 'insufficient', tone: 'warn' };
    default:
      return { kind: 'collecting', tone: 'neutral' };
  }
}

/** The freeze point is shared by all three metrics; take whichever carries it. */
export function frozenAtOf(metrics: Record<string, MetricBlock>): string | null {
  return Object.values(metrics).find((m) => m.verdict.frozenAt)?.verdict.frozenAt ?? null;
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../db/client';
import { resetDb } from '../../../test/db-reset';
import { benchmarkRuns } from '../../../db/schema';
import { getBenchmarkLeaderboard } from './benchmark';

beforeEach(resetDb);

describe('benchmark.getBenchmarkLeaderboard', () => {
  afterEach(() => vi.restoreAllMocks());

  it('aggregates the latest batch per model and ranks by fidelity', async () => {
    const rows = [
      {
        model: 'opus',
        taskId: 't1',
        runIndex: 0,
        output: 'a',
        vectorFidelity: 0.9,
        judgeScore: 90,
        ruleScore: 1,
        latencyMs: 100,
      },
      {
        model: 'opus',
        taskId: 't1',
        runIndex: 1,
        output: 'b',
        vectorFidelity: 0.88,
        judgeScore: 88,
        ruleScore: 1,
        latencyMs: 110,
      },
      {
        model: 'haiku',
        taskId: 't1',
        runIndex: 0,
        output: 'c',
        vectorFidelity: 0.7,
        judgeScore: 70,
        ruleScore: 0.5,
        latencyMs: 40,
      },
      {
        model: 'haiku',
        taskId: 't1',
        runIndex: 1,
        output: 'd',
        vectorFidelity: 0.6,
        judgeScore: 60,
        ruleScore: 0.5,
        latencyMs: 42,
      },
    ];
    await db.insert(benchmarkRuns).values(
      rows.map((r) => ({
        batchId: 'b1',
        persona: 'liushang',
        personaDisplay: '流觞',
        taskKind: 'post',
        ruleDetail: '',
        capturedAt: new Date(),
        ...r,
      })),
    );

    const out = await getBenchmarkLeaderboard();

    expect(out.totalRuns).toBe(4);
    expect(out.rows.map((r) => r.model)).toEqual(['opus', 'haiku']); // opus first (higher fidelity)
    expect(out.rows[0]).toMatchObject({ model: 'opus', runs: 2 });
    expect(out.rows[0].fidelity).toBeCloseTo(0.89, 5);
    expect(out.rows[1].fidelity).toBeCloseTo(0.65, 5);
    // opus is steadier (tighter cell) → higher consistency than haiku
    expect(out.rows[0].consistency ?? 0).toBeGreaterThan(out.rows[1].consistency ?? 0);
    expect(out.personas).toContainEqual({ persona: 'liushang', display: '流觞' });
    expect(out.tasks).toContainEqual({ taskId: 't1', kind: 'post' });
  });
});

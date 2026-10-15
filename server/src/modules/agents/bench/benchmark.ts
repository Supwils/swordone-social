/**
 * Persona Bench — the offline model-comparison eval lane.
 *
 * Split out of the former 2018-line agents.service.ts (nine unrelated concerns,
 * six times the 300-line service ceiling). Imported directly since the S2
 * module split; there is no barrel.
 */
import { desc, eq } from 'drizzle-orm';
import { db } from '../../../db/client';
import { benchmarkRuns } from '../../../db/schema';
import { TTLCache } from '../../../lib/ttlCache';
import type { BenchmarkRunIngestInput } from './bench.schemas';
import type {
  BenchmarkCompareDTO,
  BenchmarkCompareItemDTO,
  BenchmarkLeaderboardDTO,
  BenchmarkLeaderboardRowDTO,
  BenchmarkMatrixCellDTO,
  BenchmarkMatrixDTO,
} from '../../../contract/lab/bench';

/* ---------- Persona Bench: ingest + reads ---------- */

export async function ingestBenchmarkRun(input: BenchmarkRunIngestInput): Promise<{ id: string }> {
  const [doc] = await db
    .insert(benchmarkRuns)
    .values({
      batchId: input.batchId,
      persona: input.persona,
      personaDisplay: input.personaDisplay ?? '',
      model: input.model,
      taskId: input.taskId,
      taskKind: input.taskKind ?? '',
      runIndex: input.runIndex ?? 0,
      output: input.output ?? '',
      vectorFidelity: input.vectorFidelity ?? null,
      judgeScore: input.judgeScore ?? null,
      ruleScore: input.ruleScore ?? null,
      ruleDetail: input.ruleDetail ?? '',
      latencyMs: input.latencyMs ?? null,
      capturedAt: input.capturedAt ?? new Date(),
    })
    .returning();
  return { id: doc.id };
}

interface BenchRow {
  persona: string;
  personaDisplay: string;
  model: string;
  taskId: string;
  taskKind: string;
  runIndex: number;
  output: string;
  vectorFidelity: number | null;
  judgeScore: number | null;
  ruleScore: number | null;
  ruleDetail: string;
  latencyMs: number | null;
}

const avgOf = (xs: Array<number | null>): number | null => {
  const v = xs.filter((x): x is number => typeof x === 'number');
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const stddevOf = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};

/** Load the most-recent batch's rows — the leaderboard reflects the latest sweep. */
async function loadLatestBenchRows(): Promise<BenchRow[]> {
  const [latest] = await db
    .select({ batchId: benchmarkRuns.batchId })
    .from(benchmarkRuns)
    .orderBy(desc(benchmarkRuns.createdAt))
    .limit(1);
  if (!latest?.batchId) return [];
  return db
    .select({
      persona: benchmarkRuns.persona,
      personaDisplay: benchmarkRuns.personaDisplay,
      model: benchmarkRuns.model,
      taskId: benchmarkRuns.taskId,
      taskKind: benchmarkRuns.taskKind,
      runIndex: benchmarkRuns.runIndex,
      output: benchmarkRuns.output,
      vectorFidelity: benchmarkRuns.vectorFidelity,
      judgeScore: benchmarkRuns.judgeScore,
      ruleScore: benchmarkRuns.ruleScore,
      ruleDetail: benchmarkRuns.ruleDetail,
      latencyMs: benchmarkRuns.latencyMs,
    })
    .from(benchmarkRuns)
    .where(eq(benchmarkRuns.batchId, latest.batchId));
}

const benchLeaderboardCache = new TTLCache<string, BenchmarkLeaderboardDTO>(30_000);
export async function getBenchmarkLeaderboard(): Promise<BenchmarkLeaderboardDTO> {
  return benchLeaderboardCache.getOrLoad('latest', computeBenchmarkLeaderboard);
}
async function computeBenchmarkLeaderboard(): Promise<BenchmarkLeaderboardDTO> {
  const rows = await loadLatestBenchRows();
  const byModel = new Map<string, BenchRow[]>();
  const personas = new Map<string, string>();
  const tasks = new Map<string, string>();
  for (const r of rows) {
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model)!.push(r);
    personas.set(r.persona, r.personaDisplay || r.persona);
    tasks.set(r.taskId, r.taskKind || '');
  }

  const out: BenchmarkLeaderboardRowDTO[] = [];
  for (const [modelName, mrows] of byModel) {
    // Consistency: average within-(persona,task) stddev of fidelity, inverted.
    const cellGroups = new Map<string, number[]>();
    for (const r of mrows) {
      if (typeof r.vectorFidelity === 'number') {
        const k = `${r.persona}|${r.taskId}`;
        if (!cellGroups.has(k)) cellGroups.set(k, []);
        cellGroups.get(k)!.push(r.vectorFidelity);
      }
    }
    const sds = [...cellGroups.values()].filter((g) => g.length >= 2).map(stddevOf);
    const meanSd = sds.length ? sds.reduce((a, b) => a + b, 0) / sds.length : null;
    out.push({
      model: modelName,
      runs: mrows.length,
      fidelity: avgOf(mrows.map((r) => r.vectorFidelity)),
      judge: avgOf(mrows.map((r) => r.judgeScore)),
      rule: avgOf(mrows.map((r) => r.ruleScore)),
      consistency: meanSd === null ? null : Math.max(0, 1 - meanSd * 4),
      latencyMs: avgOf(mrows.map((r) => r.latencyMs)),
    });
  }
  // Best persona-fidelity first.
  out.sort((a, b) => (b.fidelity ?? -1) - (a.fidelity ?? -1));

  return {
    rows: out,
    personas: [...personas].map(([persona, display]) => ({ persona, display })),
    tasks: [...tasks].map(([taskId, kind]) => ({ taskId, kind })),
    totalRuns: rows.length,
  };
}

const benchMatrixCache = new TTLCache<string, BenchmarkMatrixDTO>(30_000);
export async function getBenchmarkMatrix(): Promise<BenchmarkMatrixDTO> {
  return benchMatrixCache.getOrLoad('latest', computeBenchmarkMatrix);
}
async function computeBenchmarkMatrix(): Promise<BenchmarkMatrixDTO> {
  const rows = await loadLatestBenchRows();
  const models = [...new Set(rows.map((r) => r.model))];
  const personaMap = new Map<string, string>();
  const cellRows = new Map<string, BenchRow[]>();
  for (const r of rows) {
    personaMap.set(r.persona, r.personaDisplay || r.persona);
    const k = `${r.persona}|${r.model}`;
    if (!cellRows.has(k)) cellRows.set(k, []);
    cellRows.get(k)!.push(r);
  }
  const cells: BenchmarkMatrixCellDTO[] = [];
  for (const [k, group] of cellRows) {
    const [persona, model] = k.split('|');
    cells.push({
      persona,
      model,
      fidelity: avgOf(group.map((r) => r.vectorFidelity)),
      judge: avgOf(group.map((r) => r.judgeScore)),
      n: group.length,
    });
  }
  return {
    models,
    personas: [...personaMap].map(([persona, display]) => ({ persona, display })),
    cells,
  };
}

export async function getBenchmarkCompare(
  persona: string,
  task: string,
): Promise<BenchmarkCompareDTO> {
  const rows = await loadLatestBenchRows();
  const items: BenchmarkCompareItemDTO[] = rows
    .filter((r) => r.persona === persona && r.taskId === task)
    .sort((a, b) => a.model.localeCompare(b.model) || a.runIndex - b.runIndex)
    .map((r) => ({
      model: r.model,
      runIndex: r.runIndex,
      output: r.output,
      vectorFidelity: r.vectorFidelity,
      judgeScore: r.judgeScore,
      ruleScore: r.ruleScore,
      ruleDetail: r.ruleDetail,
    }));
  return { persona, task, items };
}

/**
 * `GET /agents/arms` — the Era 3 arms report (spec §7, amendment 1).
 *
 * Rounds and the window come from `rounds.ts`, the three confirmatory metrics
 * from `metrics.ts`, the exploratory instruments from `homophily.ts`,
 * `contagion.ts` and `reliability.ts`. Statistics read the window only, so
 * rounds after the 12th completed one cannot move the verdict.
 */
import { TTLCache } from '../../../lib/ttlCache';
import { ARMS } from '../lab/roster';
import type { ArmsReportDTO } from '../../../contract/lab/arms';
import { contagionReport, resetEra2Baseline } from './contagion';
import { homophilyReport } from './homophily';
import {
  convergenceBlock,
  fidelityBlock,
  loadWindowCandidates,
  loadWindowPosts,
  repetitionBlock,
} from './metrics';
import { MIN_ARM_ROUNDS, TARGET_ROUNDS } from './protocol';
import { buildReliability } from './reliability';
import { loadRoundsState } from './rounds';

const armsReportCache = new TTLCache<string, ArmsReportDTO>(60_000);

/**
 * Test hook — the 60 s TTL would otherwise pin the first report of a suite;
 * the per-process Era 2 token memo is dropped with it.
 */
export function clearArmsReportCache(): void {
  armsReportCache.clear();
  resetEra2Baseline();
}

export async function getArmsReport(): Promise<ArmsReportDTO> {
  return armsReportCache.getOrLoad('report', computeArmsReport);
}

async function computeArmsReport(): Promise<ArmsReportDTO> {
  const state = await loadRoundsState();
  const [posts, candidates, homophily, contagion] = await Promise.all([
    loadWindowPosts(state),
    loadWindowCandidates(state),
    homophilyReport(state.roster),
    contagionReport(state),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    arms: ARMS.map((a) => ({ id: a.id, model: a.model, accounts: [...a.usernames] })),
    rounds: state.rounds,
    completedRounds: state.completedRounds,
    targetRounds: TARGET_ROUNDS,
    minArmRounds: MIN_ARM_ROUNDS,
    armRounds: state.armRounds,
    metrics: {
      fidelity: fidelityBlock(state, posts, candidates),
      repetition: repetitionBlock(state, candidates),
      convergence: convergenceBlock(state, posts),
    },
    exploratory: { homophily, contagion, reliability: buildReliability(state, candidates) },
  };
}

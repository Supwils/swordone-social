import { apiPath, http, unwrap } from '@/api/client';
import type {
  AccountRoundsDTO,
  AgentSummaryDTO,
  ArmsReportDTO,
  LabEra,
  LabRange,
  AgentEventDTO,
  AgentOverviewDTO,
  AgentStatsDTO,
  AlertsDTO,
  CollapseWatchDTO,
  DriftCountdownDTO,
  DriftPointDTO,
  FidelityDTO,
  HomogenizationDTO,
  InfluencesDTO,
  InteractionGraphDTO,
  PulseDTO,
  RuntimeHealthDTO,
  BenchmarkLeaderboardDTO,
  BenchmarkMatrixDTO,
  BenchmarkCompareDTO,
} from '@/features/lab/types';

/**
 * Era-aware population reads (S2 §6). `era` is required and ALWAYS sent: the
 * server defaults a missing era to 3, so a read that dropped it would serve the
 * live roster to the sealed Era 2 view and look entirely plausible.
 */
function withEra(qs: URLSearchParams, era: LabEra): URLSearchParams {
  qs.set('era', String(era));
  return qs;
}

/** `path` (built with `apiPath`, so every segment is encoded) plus a query. */
function withQuery(path: string, qs: URLSearchParams): string {
  const q = qs.toString();
  return q ? `${path}?${q}` : path;
}

export async function listLabAgents(era: LabEra, limit = 50): Promise<AgentSummaryDTO[]> {
  const qs = withEra(new URLSearchParams({ limit: String(limit) }), era);
  const out = await unwrap<{ items: AgentSummaryDTO[] }>(http.get(withQuery('/agents', qs)));
  return out.items;
}

export async function getAgentOverview(era: LabEra): Promise<AgentOverviewDTO> {
  const qs = withEra(new URLSearchParams(), era);
  return unwrap<AgentOverviewDTO>(http.get(withQuery('/agents/overview', qs)));
}

export async function getInteractionGraph(
  era: LabEra,
  range: LabRange = '30d',
): Promise<InteractionGraphDTO> {
  const qs = withEra(new URLSearchParams({ range }), era);
  return unwrap<InteractionGraphDTO>(http.get(withQuery('/agents/graph', qs)));
}

export async function getHomogenization(
  era: LabEra,
  range: LabRange = '30d',
): Promise<HomogenizationDTO> {
  const qs = withEra(new URLSearchParams({ range }), era);
  return unwrap<HomogenizationDTO>(http.get(withQuery('/agents/homogenization', qs)));
}

export async function getAlerts(era: LabEra, range: LabRange = '30d'): Promise<AlertsDTO> {
  const qs = withEra(new URLSearchParams({ range }), era);
  return unwrap<AlertsDTO>(http.get(withQuery('/agents/alerts', qs)));
}

export async function getPopulationPulse(era: LabEra, range: LabRange = '30d'): Promise<PulseDTO> {
  const qs = withEra(new URLSearchParams({ range }), era);
  return unwrap<PulseDTO>(http.get(withQuery('/agents/pulse', qs)));
}

/**
 * Cycle-engine golden signals for the /lab header strip. `range` is
 * threaded, never defaulted at the call site: the server's own default is
 * `30d`, so a caller that dropped the argument would be indistinguishable
 * from one asking for 30 days.
 */
export async function getRuntimeHealth(era: LabEra, range: LabRange): Promise<RuntimeHealthDTO> {
  const qs = withEra(new URLSearchParams({ range }), era);
  return unwrap<RuntimeHealthDTO>(http.get(withQuery('/agents/runtime', qs)));
}

/** Era 3 arms report (S2 §7) — pre-registered metrics per model arm. Era 3 only. */
export async function getArmsReport(): Promise<ArmsReportDTO> {
  return unwrap<ArmsReportDTO>(http.get('/agents/arms'));
}

/** One account's rounds, newest first, at most 60 (S2 §7). */
export async function getAccountRounds(username: string): Promise<AccountRoundsDTO> {
  return unwrap<AccountRoundsDTO>(http.get(apiPath`/agents/${username}/rounds`));
}

export async function getBenchmarkLeaderboard(): Promise<BenchmarkLeaderboardDTO> {
  return unwrap<BenchmarkLeaderboardDTO>(http.get('/agents/benchmark/leaderboard'));
}

export async function getBenchmarkMatrix(): Promise<BenchmarkMatrixDTO> {
  return unwrap<BenchmarkMatrixDTO>(http.get('/agents/benchmark/matrix'));
}

export async function getBenchmarkCompare(
  persona: string,
  task: string,
): Promise<BenchmarkCompareDTO> {
  const qs = new URLSearchParams({ persona, task });
  return unwrap<BenchmarkCompareDTO>(http.get(withQuery('/agents/benchmark/compare', qs)));
}

export async function getInfluences(
  username: string,
  range: '7d' | '30d' | '90d' = '30d',
): Promise<InfluencesDTO> {
  return unwrap<InfluencesDTO>(
    http.get(withQuery(apiPath`/agents/${username}/influences`, new URLSearchParams({ range }))),
  );
}

export async function getAgentStats(
  username: string,
  range: '7d' | '30d' | '90d' = '30d',
): Promise<AgentStatsDTO> {
  return unwrap<AgentStatsDTO>(
    http.get(withQuery(apiPath`/agents/${username}/stats`, new URLSearchParams({ range }))),
  );
}

export async function getAgentDrift(username: string): Promise<DriftPointDTO[]> {
  const out = await unwrap<{ snapshots: DriftPointDTO[] }>(
    http.get(apiPath`/agents/${username}/drift`),
  );
  return out.snapshots;
}

export async function getAgentFidelity(username: string): Promise<FidelityDTO> {
  return unwrap<FidelityDTO>(http.get(apiPath`/agents/${username}/fidelity`));
}

export async function getAgentEvents(
  username: string,
  limit = 20,
  type?: AgentEventDTO['type'],
): Promise<AgentEventDTO[]> {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (type) qs.set('type', type);
  const out = await unwrap<{ items: AgentEventDTO[] }>(
    http.get(withQuery(apiPath`/agents/${username}/events`, qs)),
  );
  return out.items;
}

/**
 * Projected time-to-lockout for one account, fitted over the UNCENSORED
 * `agent_events` measurement series. It projects and enforces nothing.
 *
 * `range` is threaded, never defaulted at the call site: the server's own
 * default is `30d`, so a caller that dropped the argument would be
 * indistinguishable from one asking for 30 days.
 */
export async function getDriftCountdown(
  username: string,
  range: '7d' | '30d' | '90d',
): Promise<DriftCountdownDTO> {
  return unwrap<DriftCountdownDTO>(
    http.get(
      withQuery(apiPath`/agents/${username}/drift-countdown`, new URLSearchParams({ range })),
    ),
  );
}

/**
 * Act-path collapse watch for one account: post length, plus the act path's
 * self-similarity where that series exists. It measures and enforces nothing.
 */
export async function getCollapseWatch(
  username: string,
  range: '7d' | '30d' | '90d',
): Promise<CollapseWatchDTO> {
  return unwrap<CollapseWatchDTO>(
    http.get(withQuery(apiPath`/agents/${username}/collapse`, new URLSearchParams({ range }))),
  );
}

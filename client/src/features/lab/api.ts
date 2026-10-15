import { http } from '@/api/client';
import type { ApiEnvelope } from '@/api/types';
import type {
  AccountRoundsDTO,
  AgentLabSummary,
  ArmsReportDTO,
  LabEra,
  LabRange,
  AgentEventDTO,
  AgentOverviewDTO,
  AgentStatsDTO,
  AlertsDTO,
  CollapseWatchDTO,
  DriftCountdownDTO,
  DriftPoint,
  FidelityDTO,
  HomogenizationDTO,
  InfluencesDTO,
  InteractionGraphDTO,
  PulseDTO,
  RuntimeHealthDTO,
  BenchmarkLeaderboard,
  BenchmarkMatrix,
  BenchmarkCompare,
} from '@/features/lab/types';

/**
 * Era-aware population reads (S2 §6). `era` is required and ALWAYS sent: the
 * server defaults a missing era to 3, so a read that dropped it would serve the
 * live roster to the sealed Era 2 view and look entirely plausible.
 */
function withEra(qs: URLSearchParams, era: LabEra): string {
  qs.set('era', String(era));
  return qs.toString();
}

export async function listLabAgents(era: LabEra, limit = 50): Promise<AgentLabSummary[]> {
  const qs = withEra(new URLSearchParams({ limit: String(limit) }), era);
  const { data } = await http.get<ApiEnvelope<{ items: AgentLabSummary[] }>>(`/agents?${qs}`);
  return data.data.items;
}

export async function getAgentOverview(era: LabEra): Promise<AgentOverviewDTO> {
  const qs = withEra(new URLSearchParams(), era);
  const { data } = await http.get<ApiEnvelope<AgentOverviewDTO>>(`/agents/overview?${qs}`);
  return data.data;
}

export async function getInteractionGraph(
  era: LabEra,
  range: LabRange = '30d',
): Promise<InteractionGraphDTO> {
  const qs = withEra(new URLSearchParams({ range }), era);
  const { data } = await http.get<ApiEnvelope<InteractionGraphDTO>>(`/agents/graph?${qs}`);
  return data.data;
}

export async function getHomogenization(
  era: LabEra,
  range: LabRange = '30d',
): Promise<HomogenizationDTO> {
  const qs = withEra(new URLSearchParams({ range }), era);
  const { data } = await http.get<ApiEnvelope<HomogenizationDTO>>(`/agents/homogenization?${qs}`);
  return data.data;
}

export async function getAlerts(era: LabEra, range: LabRange = '30d'): Promise<AlertsDTO> {
  const qs = withEra(new URLSearchParams({ range }), era);
  const { data } = await http.get<ApiEnvelope<AlertsDTO>>(`/agents/alerts?${qs}`);
  return data.data;
}

export async function getPopulationPulse(era: LabEra, range: LabRange = '30d'): Promise<PulseDTO> {
  const qs = withEra(new URLSearchParams({ range }), era);
  const { data } = await http.get<ApiEnvelope<PulseDTO>>(`/agents/pulse?${qs}`);
  return data.data;
}

/**
 * Cycle-engine golden signals for the /lab header strip. `range` is
 * threaded, never defaulted at the call site: the server's own default is
 * `30d`, so a caller that dropped the argument would be indistinguishable
 * from one asking for 30 days.
 */
export async function getRuntimeHealth(era: LabEra, range: LabRange): Promise<RuntimeHealthDTO> {
  const qs = withEra(new URLSearchParams({ range }), era);
  const { data } = await http.get<ApiEnvelope<RuntimeHealthDTO>>(`/agents/runtime?${qs}`);
  return data.data;
}

/** Era 3 arms report (S2 §7) — pre-registered metrics per model arm. Era 3 only. */
export async function getArmsReport(): Promise<ArmsReportDTO> {
  const { data } = await http.get<ApiEnvelope<ArmsReportDTO>>(`/agents/arms`);
  return data.data;
}

/** One account's rounds, newest first, at most 60 (S2 §7). */
export async function getAccountRounds(username: string): Promise<AccountRoundsDTO> {
  const { data } = await http.get<ApiEnvelope<AccountRoundsDTO>>(
    `/agents/${encodeURIComponent(username)}/rounds`,
  );
  return data.data;
}

export async function getBenchmarkLeaderboard(): Promise<BenchmarkLeaderboard> {
  const { data } = await http.get<ApiEnvelope<BenchmarkLeaderboard>>(
    `/agents/benchmark/leaderboard`,
  );
  return data.data;
}

export async function getBenchmarkMatrix(): Promise<BenchmarkMatrix> {
  const { data } = await http.get<ApiEnvelope<BenchmarkMatrix>>(`/agents/benchmark/matrix`);
  return data.data;
}

export async function getBenchmarkCompare(
  persona: string,
  task: string,
): Promise<BenchmarkCompare> {
  const qs = new URLSearchParams({ persona, task });
  const { data } = await http.get<ApiEnvelope<BenchmarkCompare>>(
    `/agents/benchmark/compare?${qs.toString()}`,
  );
  return data.data;
}

export async function getInfluences(
  username: string,
  range: '7d' | '30d' | '90d' = '30d',
): Promise<InfluencesDTO> {
  const { data } = await http.get<ApiEnvelope<InfluencesDTO>>(
    `/agents/${username}/influences?range=${range}`,
  );
  return data.data;
}

export async function getAgentStats(
  username: string,
  range: '7d' | '30d' | '90d' = '30d',
): Promise<AgentStatsDTO> {
  const { data } = await http.get<ApiEnvelope<AgentStatsDTO>>(
    `/agents/${username}/stats?range=${range}`,
  );
  return data.data;
}

export async function getAgentDrift(username: string): Promise<DriftPoint[]> {
  const { data } = await http.get<ApiEnvelope<{ snapshots: DriftPoint[] }>>(
    `/agents/${username}/drift`,
  );
  return data.data.snapshots;
}

export async function getAgentFidelity(username: string): Promise<FidelityDTO> {
  const { data } = await http.get<ApiEnvelope<FidelityDTO>>(`/agents/${username}/fidelity`);
  return data.data;
}

export async function getAgentEvents(
  username: string,
  limit = 20,
  type?: AgentEventDTO['type'],
): Promise<AgentEventDTO[]> {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (type) qs.set('type', type);
  const { data } = await http.get<ApiEnvelope<{ items: AgentEventDTO[] }>>(
    `/agents/${username}/events?${qs.toString()}`,
  );
  return data.data.items;
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
  const { data } = await http.get<ApiEnvelope<DriftCountdownDTO>>(
    `/agents/${username}/drift-countdown?range=${range}`,
  );
  return data.data;
}

/**
 * Act-path collapse watch for one account: post length, plus the act path's
 * self-similarity where that series exists. It measures and enforces nothing.
 */
export async function getCollapseWatch(
  username: string,
  range: '7d' | '30d' | '90d',
): Promise<CollapseWatchDTO> {
  const { data } = await http.get<ApiEnvelope<CollapseWatchDTO>>(
    `/agents/${username}/collapse?range=${range}`,
  );
  return data.data;
}

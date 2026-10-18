/* ---------- Agent Behavior Lab (/lab) ----------
 *
 * Every lab read shape comes from the API contract (`@/contract`, a generated
 * copy of `server/src/contract/lab/*`; never edit it by hand). Names follow
 * the server — there are no client aliases. Only the names the lab reads are
 * re-exported; add one here when a component needs it. View-only types that
 * never cross the wire belong in the component that needs them.
 */

export type {
  // era.ts
  ArmId,
  LabCohort,
  LabEra,
  LabRange,
  // population.ts
  AgentOverviewDTO,
  AgentStatsDTO,
  AgentSummaryDTO,
  AlertsDTO,
  GraphEdgeDTO,
  GraphNodeDTO,
  HomogenizationDTO,
  InfluencesDTO,
  InteractionGraphDTO,
  PulseDTO,
  // persona.ts
  CollapseSeriesDTO,
  CollapseWatchDTO,
  DriftCountdownDTO,
  DriftCountdownKey,
  DriftCountdownSeriesDTO,
  DriftPointDTO,
  FidelityDTO,
  // runtime.ts
  AgentEventDTO,
  RuntimeHealthDTO,
  // bench.ts
  BenchmarkCompareDTO,
  BenchmarkLeaderboardDTO,
  BenchmarkMatrixDTO,
  // arms.ts
  AccountRoundDTO,
  AccountRoundsDTO,
  ArmsReportDTO,
  MetricBlock,
  SeriesPoint,
  Verdict,
  // rounds.ts
  RoundDigestDTO,
  RoundListItem,
  RoundsListDTO,
} from '@/contract';

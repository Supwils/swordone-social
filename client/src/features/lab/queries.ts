import { useQuery } from '@tanstack/react-query';
import {
  getAgentDrift,
  getAlerts,
  getDriftCountdown,
  getHomogenization,
  getInteractionGraph,
  getPopulationPulse,
} from '@/features/lab/api';
import type { LabEra, LabRange } from '@/features/lab/types';

/**
 * Query keys for every lab read. One factory, so a query declared by several
 * panels cannot drift apart in key or freshness (the drift series used to be
 * cached at 5 minutes in one place and 60 s in two others).
 */
export const labKeys = {
  agents: (era: LabEra) => ['lab-agents', era] as const,
  overview: (era: LabEra) => ['lab-overview', era] as const,
  graph: (era: LabEra, range: LabRange) => ['lab-graph', era, range] as const,
  pulse: (era: LabEra, range: LabRange) => ['lab-pulse', era, range] as const,
  homogenization: (era: LabEra, range: LabRange) => ['lab-homogenization', era, range] as const,
  alerts: (era: LabEra, range: LabRange) => ['lab-alerts', era, range] as const,
  runtime: (era: LabEra, range: LabRange) => ['lab-runtime', era, range] as const,
  arms: ['lab-arms'] as const,
  accountRounds: (username: string) => ['lab-account-rounds', username] as const,
  drift: (username: string) => ['agent-drift', username] as const,
  countdown: (username: string, range: LabRange) => ['agent-countdown', username, range] as const,
  collapse: (username: string, range: LabRange) => ['agent-collapse', username, range] as const,
  stats: (username: string, range: LabRange) => ['agent-stats', username, range] as const,
  events: (username: string) => ['agent-events', username] as const,
  adherence: (username: string) => ['agent-adherence', username] as const,
  fidelity: (username: string) => ['agent-fidelity', username] as const,
  influences: (username: string, range: LabRange) => ['agent-influences', username, range] as const,
  benchLeaderboard: ['bench-leaderboard'] as const,
  benchMatrix: ['bench-matrix'] as const,
  benchCompare: (persona: string | null, task: string | null) =>
    ['bench-compare', persona, task] as const,
};

/** Freshness shared by every lab panel that does not poll. */
export const LAB_STALE_MS = 60_000;

export function useHomogenization(era: LabEra, range: LabRange) {
  return useQuery({
    queryKey: labKeys.homogenization(era, range),
    queryFn: () => getHomogenization(era, range),
    staleTime: LAB_STALE_MS,
  });
}

export function usePopulationPulse(era: LabEra, range: LabRange) {
  return useQuery({
    queryKey: labKeys.pulse(era, range),
    queryFn: () => getPopulationPulse(era, range),
    staleTime: LAB_STALE_MS,
  });
}

export function useLabAlerts(era: LabEra, range: LabRange) {
  return useQuery({
    queryKey: labKeys.alerts(era, range),
    queryFn: () => getAlerts(era, range),
    staleTime: LAB_STALE_MS,
  });
}

export function useInteractionGraph(
  era: LabEra,
  range: LabRange,
  opts: { enabled?: boolean; staleTime?: number; refetchInterval?: number | false } = {},
) {
  return useQuery({
    queryKey: labKeys.graph(era, range),
    queryFn: () => getInteractionGraph(era, range),
    staleTime: opts.staleTime ?? LAB_STALE_MS,
    enabled: opts.enabled,
    refetchInterval: opts.refetchInterval,
  });
}

export function useAgentDrift(username: string, enabled = true) {
  return useQuery({
    queryKey: labKeys.drift(username),
    queryFn: () => getAgentDrift(username),
    staleTime: LAB_STALE_MS,
    enabled,
  });
}

/** One query for the whole Era 2 detail view: the chart's thresholds ride on the countdown. */
export function useDriftCountdown(username: string, range: LabRange) {
  return useQuery({
    queryKey: labKeys.countdown(username, range),
    queryFn: () => getDriftCountdown(username, range),
    staleTime: LAB_STALE_MS,
  });
}

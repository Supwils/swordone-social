/** Wire shapes of the population reads: roster, stats, overview, graph, pulse, alerts. */

import type { LabCohort } from '../lab/lab.types';
import type { ArmId } from '../lab/roster';

export interface AgentSummaryDTO {
  id: string;
  username: string;
  displayName: string;
  headline: string;
  avatarUrl: string | null;
  agentBackend?: string;
  isAgent: boolean;
  /** When the account was sealed (Era 2); null for a live account. */
  archivedAt: string | null;
  /** Pre-registered Era 3 arm; null for anyone outside the roster. */
  arm: ArmId | null;
  cohort: LabCohort;
  followerCount: number;
  postCount: number;
  lastSnapshotAt: string | null;
  currentDriftFromAnchor: number | null;
  driftSparkline: number[];
  postsLast7d: number;
  /** Latest persona-fidelity (cosine sim of stated self vs revealed behavior); null until a behavior sample exists. */
  currentFidelity: number | null;
}

export interface CadencePointDTO {
  date: string; // YYYY-MM-DD
  posts: number;
  comments: number;
  likesGiven: number;
}

export interface AgentStatsDTO {
  username: string;
  range: '7d' | '30d' | '90d';
  cadence: CadencePointDTO[];
  engagement: {
    selfPostsReceived: {
      likes: { byAi: number; byHuman: number };
      comments: { byAi: number; byHuman: number };
    };
    given: {
      likes: { toAi: number; toHuman: number };
      comments: { toAi: number; toHuman: number };
    };
  };
  topInteractors: Array<{
    username: string;
    displayName: string;
    isAgent: boolean;
    count: number;
    kind: 'in' | 'out';
  }>;
}

export interface AgentOverviewDTO {
  totalsToday: { posts: number; comments: number; likes: number };
  mostActive: Array<{ username: string; displayName: string; posts: number }>;
  driftLeaderboard: Array<{ username: string; displayName: string; drift: number }>;
  populationCohesion: number; // mean pairwise cosine sim of latest snapshots, [0,1]
  echoChamberFlags: string[]; // agent usernames currently flagged
  /** Lab population split: first-party agents vs community (BYOA) agents vs humans. */
  cohorts: { firstParty: number; community: number; humans: number };
}

export interface GraphNodeDTO {
  username: string;
  displayName: string;
  isAgent: boolean;
  strength: number; // total incident edge weight (in + out)
}

export interface GraphEdgeDTO {
  source: string; // username
  target: string; // username
  weight: number; // total directed interactions source → target
  kinds: { comment: number; reply: number; echo: number; like: number };
}

export interface InteractionGraphDTO {
  range: '7d' | '30d' | '90d';
  nodes: GraphNodeDTO[];
  edges: GraphEdgeDTO[];
}

export interface CohesionDTO {
  personaCohesion: number;
  behaviorCohesion: number;
  n: number;
}

export interface HomogenizationPointDTO extends CohesionDTO {
  capturedAt: string;
}

export interface HomogenizationDTO {
  current: CohesionDTO;
  points: HomogenizationPointDTO[];
}

export interface PulsePointDTO {
  date: string; // YYYY-MM-DD (UTC)
  posts: number;
  comments: number;
  likes: number;
  actions: number; // posts + comments + likes
  meanFidelity: number | null; // avg behavior-snapshot fidelity captured that day
  meanDriftVelocity: number | null; // avg personality driftFromPrev (dreams) that day
}

/** Population "vital signs" timeseries — powers the golden-signal header. */
export interface PulseDTO {
  range: '7d' | '30d' | '90d';
  points: PulsePointDTO[];
}

/**
 * `dream_rejected` is Era 1/2 wording (the retired drift gate); an Era 3
 * account's failed dream is `dream_failed`.
 */
export type AnomalyAlertKind =
  | 'drift_spike'
  | 'low_fidelity'
  | 'dream_rejected'
  | 'dream_failed'
  | 'echo_chamber'
  | 'rule_violation';

export interface AnomalyAlertDTO {
  username: string;
  displayName: string;
  isAgent: boolean;
  severity: 'info' | 'warning' | 'danger';
  kind: AnomalyAlertKind;
  message: string;
  at: string;
}

export interface AlertsDTO {
  range: '7d' | '30d' | '90d';
  alerts: AnomalyAlertDTO[];
}

export interface InfluencePartnerDTO {
  username: string;
  displayName: string;
  isAgent: boolean;
  interactions: number; // outbound interactions this agent directed at the partner
  proximity: number | null; // cosine(this agent's behavior vec, partner's behavior vec)
}

export interface InfluencesDTO {
  username: string;
  range: '7d' | '30d' | '90d';
  drift: Array<{ capturedAt: string; distanceFromAnchor: number }>;
  activity: Array<{ date: string; actions: number }>;
  partners: InfluencePartnerDTO[];
}

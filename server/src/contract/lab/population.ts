/** Population reads: roster, stats, overview, graph, homogenization, pulse, alerts, influences. */
import { z } from 'zod';
import { armIdSchema, labCohortSchema, labRangeSchema } from './era';

export const AgentSummaryDTOSchema = z
  .object({
    id: z.string(),
    username: z.string(),
    displayName: z.string(),
    headline: z.string(),
    avatarUrl: z.string().nullable(),
    agentBackend: z.string().optional(),
    isAgent: z.boolean(),
    /** When the account was sealed (Era 2); null for a live account. */
    archivedAt: z.string().nullable(),
    /** Pre-registered Era 3 arm; null for anyone outside the roster. */
    arm: armIdSchema.nullable(),
    cohort: labCohortSchema,
    followerCount: z.number(),
    postCount: z.number(),
    lastSnapshotAt: z.string().nullable(),
    currentDriftFromAnchor: z.number().nullable(),
    driftSparkline: z.array(z.number()),
    postsLast7d: z.number(),
    /** Latest persona-fidelity (cosine sim of stated self vs revealed behavior); null until a behavior sample exists. */
    currentFidelity: z.number().nullable(),
  })
  .strict();
export type AgentSummaryDTO = z.infer<typeof AgentSummaryDTOSchema>;

export const CadencePointDTOSchema = z
  .object({
    date: z.string(), // YYYY-MM-DD
    posts: z.number(),
    comments: z.number(),
    likesGiven: z.number(),
  })
  .strict();
export type CadencePointDTO = z.infer<typeof CadencePointDTOSchema>;

const aiHumanCounts = z.object({ byAi: z.number(), byHuman: z.number() }).strict();
const toAiHumanCounts = z.object({ toAi: z.number(), toHuman: z.number() }).strict();

export const AgentStatsDTOSchema = z
  .object({
    username: z.string(),
    range: labRangeSchema,
    cadence: z.array(CadencePointDTOSchema),
    engagement: z
      .object({
        selfPostsReceived: z.object({ likes: aiHumanCounts, comments: aiHumanCounts }).strict(),
        given: z.object({ likes: toAiHumanCounts, comments: toAiHumanCounts }).strict(),
      })
      .strict(),
    topInteractors: z.array(
      z
        .object({
          username: z.string(),
          displayName: z.string(),
          isAgent: z.boolean(),
          count: z.number(),
          kind: z.enum(['in', 'out']),
        })
        .strict(),
    ),
  })
  .strict();
export type AgentStatsDTO = z.infer<typeof AgentStatsDTOSchema>;

export const AgentOverviewDTOSchema = z
  .object({
    totalsToday: z.object({ posts: z.number(), comments: z.number(), likes: z.number() }).strict(),
    mostActive: z.array(
      z.object({ username: z.string(), displayName: z.string(), posts: z.number() }).strict(),
    ),
    driftLeaderboard: z.array(
      z.object({ username: z.string(), displayName: z.string(), drift: z.number() }).strict(),
    ),
    populationCohesion: z.number(), // mean pairwise cosine sim of latest snapshots, [0,1]
    echoChamberFlags: z.array(z.string()), // agent usernames currently flagged
    /** Lab population split: first-party agents vs community (BYOA) agents vs humans. */
    cohorts: z
      .object({ firstParty: z.number(), community: z.number(), humans: z.number() })
      .strict(),
  })
  .strict();
export type AgentOverviewDTO = z.infer<typeof AgentOverviewDTOSchema>;

export const GraphNodeDTOSchema = z
  .object({
    username: z.string(),
    displayName: z.string(),
    isAgent: z.boolean(),
    strength: z.number(), // total incident edge weight (in + out)
  })
  .strict();
export type GraphNodeDTO = z.infer<typeof GraphNodeDTOSchema>;

export const GraphEdgeDTOSchema = z
  .object({
    source: z.string(), // username
    target: z.string(), // username
    weight: z.number(), // total directed interactions source → target
    kinds: z
      .object({ comment: z.number(), reply: z.number(), echo: z.number(), like: z.number() })
      .strict(),
  })
  .strict();
export type GraphEdgeDTO = z.infer<typeof GraphEdgeDTOSchema>;

export const InteractionGraphDTOSchema = z
  .object({
    range: labRangeSchema,
    nodes: z.array(GraphNodeDTOSchema),
    edges: z.array(GraphEdgeDTOSchema),
  })
  .strict();
export type InteractionGraphDTO = z.infer<typeof InteractionGraphDTOSchema>;

export const CohesionDTOSchema = z
  .object({
    personaCohesion: z.number(),
    behaviorCohesion: z.number(),
    n: z.number(),
  })
  .strict();
export type CohesionDTO = z.infer<typeof CohesionDTOSchema>;

/** One population-cohesion sample; also the response of `POST /agents/population-metric`. */
export const HomogenizationPointDTOSchema = CohesionDTOSchema.extend({
  capturedAt: z.string(),
}).strict();
export type HomogenizationPointDTO = z.infer<typeof HomogenizationPointDTOSchema>;

export const HomogenizationDTOSchema = z
  .object({
    current: CohesionDTOSchema,
    points: z.array(HomogenizationPointDTOSchema),
  })
  .strict();
export type HomogenizationDTO = z.infer<typeof HomogenizationDTOSchema>;

export const PulsePointDTOSchema = z
  .object({
    date: z.string(), // YYYY-MM-DD (UTC)
    posts: z.number(),
    comments: z.number(),
    likes: z.number(),
    actions: z.number(), // posts + comments + likes
    meanFidelity: z.number().nullable(), // avg behavior-snapshot fidelity captured that day
    meanDriftVelocity: z.number().nullable(), // avg personality driftFromPrev (dreams) that day
  })
  .strict();
export type PulsePointDTO = z.infer<typeof PulsePointDTOSchema>;

/** Population "vital signs" timeseries — powers the golden-signal header. */
export const PulseDTOSchema = z
  .object({
    range: labRangeSchema,
    points: z.array(PulsePointDTOSchema),
  })
  .strict();
export type PulseDTO = z.infer<typeof PulseDTOSchema>;

/**
 * `dream_rejected` is Era 1/2 wording (the retired drift gate); an Era 3
 * account's failed dream is `dream_failed`.
 */
export const ANOMALY_ALERT_KINDS = [
  'drift_spike',
  'low_fidelity',
  'dream_rejected',
  'dream_failed',
  'echo_chamber',
  'rule_violation',
] as const;
export type AnomalyAlertKind = (typeof ANOMALY_ALERT_KINDS)[number];

export const AnomalyAlertDTOSchema = z
  .object({
    username: z.string(),
    displayName: z.string(),
    isAgent: z.boolean(),
    severity: z.enum(['info', 'warning', 'danger']),
    kind: z.enum(ANOMALY_ALERT_KINDS),
    message: z.string(),
    at: z.string(),
  })
  .strict();
export type AnomalyAlertDTO = z.infer<typeof AnomalyAlertDTOSchema>;

export const AlertsDTOSchema = z
  .object({
    range: labRangeSchema,
    alerts: z.array(AnomalyAlertDTOSchema),
  })
  .strict();
export type AlertsDTO = z.infer<typeof AlertsDTOSchema>;

export const InfluencePartnerDTOSchema = z
  .object({
    username: z.string(),
    displayName: z.string(),
    isAgent: z.boolean(),
    interactions: z.number(), // outbound interactions this agent directed at the partner
    proximity: z.number().nullable(), // cosine(this agent's behavior vec, partner's behavior vec)
  })
  .strict();
export type InfluencePartnerDTO = z.infer<typeof InfluencePartnerDTOSchema>;

export const InfluencesDTOSchema = z
  .object({
    username: z.string(),
    range: labRangeSchema,
    drift: z.array(z.object({ capturedAt: z.string(), distanceFromAnchor: z.number() }).strict()),
    activity: z.array(z.object({ date: z.string(), actions: z.number() }).strict()),
    partners: z.array(InfluencePartnerDTOSchema),
  })
  .strict();
export type InfluencesDTO = z.infer<typeof InfluencesDTOSchema>;

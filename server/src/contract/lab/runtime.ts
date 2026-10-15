/**
 * Runtime reads: the per-account lab event stream and the runtime-health strip.
 * The event enums are shared with the ingest body (`../ingest.ts`).
 */
import { z } from 'zod';
import { labRangeSchema } from './era';

export const AGENT_EVENT_TYPES = [
  'cycle',
  'dream',
  'snapshot',
  'memory',
  'echo_flag',
  'rule_check',
  'anomaly',
] as const;
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export const AGENT_EVENT_PHASES = [
  'act',
  'dream',
  'snapshot',
  'memory',
  'echo',
  'rule',
  'anomaly',
] as const;
export type AgentEventPhase = (typeof AGENT_EVENT_PHASES)[number];

export const AGENT_EVENT_OUTCOMES = [
  'started',
  'success',
  'skip',
  'fail',
  'warn',
  'flagged',
  'cleared',
] as const;
export type AgentEventOutcome = (typeof AGENT_EVENT_OUTCOMES)[number];

export const AGENT_EVENT_ACTIONS = [
  'post',
  'comment',
  'like',
  'follow',
  'unfollow',
  'delete',
  'dm',
  'echo',
  'nothing',
] as const;
export type AgentEventAction = (typeof AGENT_EVENT_ACTIONS)[number];

/** One lab event. `action`, `reason` and `targetId` are absent when the row has none. */
export const AgentEventDTOSchema = z
  .object({
    id: z.string(),
    type: z.enum(AGENT_EVENT_TYPES),
    phase: z.enum(AGENT_EVENT_PHASES),
    outcome: z.enum(AGENT_EVENT_OUTCOMES),
    action: z.enum(AGENT_EVENT_ACTIONS).optional(),
    summary: z.string(),
    reason: z.string().optional(),
    targetId: z.string().optional(),
    metrics: z.record(z.string(), z.unknown()),
    createdAt: z.string(),
  })
  .strict();
export type AgentEventDTO = z.infer<typeof AgentEventDTOSchema>;

/** One UTC day of cycle_run cards — powers the /lab runtime-health strip. */
export const RuntimeHealthPointDTOSchema = z
  .object({
    date: z.string(), // YYYY-MM-DD
    rounds: z.number(),
    failOpen: z.number(),
    missingSamples: z.number(),
    landed: z.number(),
    /** cycle_run cards whose post landed without a post vector. */
    missingPostVectors: z.number(),
  })
  .strict();
export type RuntimeHealthPointDTO = z.infer<typeof RuntimeHealthPointDTOSchema>;

/**
 * Aggregate of `agent_events` rows with `type='cycle'` and
 * `metrics.kind='cycle_run'`. Per-action cycle events and missingSampler
 * audit rows (same type, no kind) are excluded.
 */
export const RuntimeHealthDTOSchema = z
  .object({
    range: labRangeSchema,
    rounds: z.number(),
    accountsRun: z.number(),
    failOpenGates: z.number(),
    missingSamples: z.number(),
    landedActions: z.number(),
    /** cycle_run cards with `missingPostVector: true` (Era 3 act path). */
    missingPostVectors: z.number(),
    points: z.array(RuntimeHealthPointDTOSchema),
  })
  .strict();
export type RuntimeHealthDTO = z.infer<typeof RuntimeHealthDTOSchema>;

// GENERATED from server/src/contract by contract:sync — do not edit.
/**
 * The request bodies the agent POSTs to the lab, and what each ingest returns.
 * `contract:sync` turns every `…Ingest` body into a JSON Schema under
 * `agent/tests/contract/`, which the agent's pytest validates its real bodies
 * against.
 *
 * Bodies are plain (stripping) objects as they always were: an unknown key is
 * dropped by the server. The JSON Schema is stricter on purpose
 * (`additionalProperties: false`), so a typo in an agent field fails a test
 * instead of being dropped in production.
 *
 * `POST /agents/population-metric` takes no body; it returns a
 * `HomogenizationPointDTO` (`./lab/population`).
 */
import { z } from 'zod';
import { LIMITS, USERNAME_RE } from './common';
import {
  AGENT_EVENT_ACTIONS,
  AGENT_EVENT_OUTCOMES,
  AGENT_EVENT_PHASES,
  AGENT_EVENT_TYPES,
  AgentEventDTOSchema,
} from './lab/runtime';

// ── Lab events: POST /agents/:username/events ───────────────────────────────

const agentEventFields = z.object({
  type: z.enum(AGENT_EVENT_TYPES),
  phase: z.enum(AGENT_EVENT_PHASES),
  outcome: z.enum(AGENT_EVENT_OUTCOMES),
  action: z.enum(AGENT_EVENT_ACTIONS).optional(),
  summary: z.string().trim().min(1).max(500),
  reason: z.string().trim().max(300).optional(),
  targetId: z.string().trim().max(80).optional(),
  // When the thing being recorded happened, if that is not "now". The column
  // it overrides is `created_at` (agent_events has no `captured_at`), which is
  // also the column every /lab read orders and filters by -- so an event about
  // a past moment has to carry that moment or it lands beside the wrong part
  // of the series it exists to annotate. Named `occurredAt` and NOT
  // `capturedAt` on purpose: the other three ingest DTOs' `capturedAt` maps to
  // a real `captured_at` column, and reusing the name for a different column
  // is what sends a reader to the wrong one.
  //
  // Accepted only for `type: 'anomaly'` (a hand intervention recorded after the
  // fact — the agent's `swil-agent intervention`, its only sender). On any other
  // type it is a 400: a backdated `cycle_run` card would change which card
  // `dedupeCards` keeps and which round `resolveRound` files a post vector under.
  occurredAt: z.coerce.date().optional(),
  metrics: z
    .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional()
    .default({}),
});

export const agentEventIngest = agentEventFields.superRefine((event, ctx) => {
  if (event.occurredAt !== undefined && event.type !== 'anomaly') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['occurredAt'],
      message: "occurredAt is accepted only for type 'anomaly'",
    });
  }
});
export type AgentEventIngestInput = z.infer<typeof agentEventIngest>;

/** `201 { event }` — the stored event as the event stream serves it. */
export const AgentEventIngestResultSchema = z.object({ event: AgentEventDTOSchema }).strict();
export type AgentEventIngestResult = z.infer<typeof AgentEventIngestResultSchema>;

// ── Post vectors: POST /agents/:username/post-vectors ───────────────────────

/** Sweep (`-r`) or manual (`-m`) round id, e.g. `20261014T060000Z-r`. */
export const ROUND_ID_RE = /^\d{8}T\d{6}Z-[rm]$/;

/** Wire contract of `agent/swil_agent/api/lab.py` `LabWrites.post_vector`. Every key is sent; unknown = null. */
export const postVectorIngest = z.object({
  postId: z.string().min(1).max(64),
  roundId: z.string().regex(ROUND_ID_RE).nullable(),
  embedding: z.array(z.number().finite()).length(1024),
  cardSim: z.number().min(-1).max(1).nullable(),
  maxSim: z.number().min(-1).max(1).nullable(),
});
export type PostVectorIngestInput = z.infer<typeof postVectorIngest>;

/**
 * `{ id }` — post vectors (201 on create, 200 on an idempotent replay, which
 * the agent requires to count a vector as filed) and benchmark runs (201).
 */
export const IngestIdResultSchema = z.object({ id: z.string() }).strict();
export type IngestIdResult = z.infer<typeof IngestIdResultSchema>;

// ── Personality snapshots: POST /agents/:username/snapshots ─────────────────

/** Per-aspect drift (Era 2; still accepted on a snapshot). */
export const aspectDriftIngest = z.object({
  mode: z.enum(['shadow', 'aspect']),
  promptVersion: z.number().int().nonnegative(),
  // cosine sims of normalized bge-m3 vectors, in [-1, 1]
  values: z.number().min(-1).max(1),
  style: z.number().min(-1).max(1),
  topic: z.number().min(-1).max(1),
  breached: z.array(z.enum(['values', 'style', 'topic'])).default([]),
});

export const snapshotIngest = z.object({
  contentHash: z
    .string()
    .length(64)
    .regex(/^[a-f0-9]+$/i, 'contentHash must be hex sha256'),
  // The column is `vector(1024)` (bge-m3); any other length is a 400, not a 500 from pgvector.
  embedding: z.array(z.number().finite()).length(1024),
  snapshotType: z.enum(['anchor', 'dream']).default('dream'),
  capturedAt: z.coerce.date().optional(),
  archivePath: z.string().max(300),
  excerpt: z.string().max(320).optional().default(''),
  diffNarrative: z.string().max(2000).optional(),
  aspectDrift: aspectDriftIngest.optional(),
});
export type SnapshotIngestInput = z.infer<typeof snapshotIngest>;

/** `201 { id, driftFromAnchor, driftFromPrev }` — distances of the stored (or deduped) snapshot. */
export const SnapshotIngestResultSchema = z
  .object({ id: z.string(), driftFromAnchor: z.number(), driftFromPrev: z.number() })
  .strict();
export type SnapshotIngestResult = z.infer<typeof SnapshotIngestResultSchema>;

// ── Behavior snapshots: POST /agents/:username/behavior-snapshots ───────────

export const behaviorSnapshotIngest = z.object({
  contentHash: z
    .string()
    .length(64)
    .regex(/^[a-f0-9]+$/i, 'contentHash must be hex sha256'),
  // The column is `vector(1024)` (bge-m3); any other length is a 400, not a 500 from pgvector.
  embedding: z.array(z.number().finite()).length(1024),
  capturedAt: z.coerce.date().optional(),
  postCount: z.coerce.number().int().min(0).optional().default(0),
  commentCount: z.coerce.number().int().min(0).optional().default(0),
  excerpt: z.string().max(320).optional().default(''),
});
export type BehaviorSnapshotIngestInput = z.infer<typeof behaviorSnapshotIngest>;

/** `201 { id, fidelity }` — fidelity is null until a personality snapshot exists to compare against. */
export const BehaviorSnapshotIngestResultSchema = z
  .object({ id: z.string(), fidelity: z.number().nullable() })
  .strict();
export type BehaviorSnapshotIngestResult = z.infer<typeof BehaviorSnapshotIngestResultSchema>;

// ── Persona Bench runs: POST /agents/benchmark/runs ─────────────────────────

export const benchmarkRunIngest = z.object({
  batchId: z.string().trim().min(1).max(80),
  // min 2 is this schema's own bound (not LIMITS.usernameMin), kept as it was.
  persona: z.string().min(2).max(LIMITS.usernameMax).regex(USERNAME_RE),
  personaDisplay: z.string().max(80).optional().default(''),
  model: z.string().trim().min(1).max(40),
  taskId: z.string().trim().min(1).max(60),
  taskKind: z.string().trim().max(40).optional().default(''),
  runIndex: z.coerce.number().int().min(0).max(64).optional().default(0),
  output: z.string().max(8000).optional().default(''),
  vectorFidelity: z.number().min(-1).max(1).nullable().optional().default(null),
  judgeScore: z.number().min(0).max(100).nullable().optional().default(null),
  ruleScore: z.number().min(0).max(1).nullable().optional().default(null),
  ruleDetail: z.string().max(500).optional().default(''),
  latencyMs: z.coerce.number().int().min(0).nullable().optional().default(null),
  capturedAt: z.coerce.date().optional(),
});
export type BenchmarkRunIngestInput = z.infer<typeof benchmarkRunIngest>;

import {
  pgTable,
  text,
  integer,
  smallint,
  doublePrecision,
  timestamp,
  jsonb,
  vector,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { newId } from '../../lib/id';

export type DriftAspect = 'values' | 'style' | 'topic';
export type AspectDrift = {
  mode: 'shadow' | 'aspect';
  promptVersion: number;
  values: number;
  style: number;
  topic: number;
  breached: DriftAspect[];
};

export const personalitySnapshots = pgTable(
  'personality_snapshots',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    userId: text('user_id').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    contentHash: text('content_hash').notNull(),
    embedding: vector('embedding', { dimensions: 1024 }).notNull(),
    snapshotType: text('snapshot_type').$type<'anchor' | 'dream'>().notNull().default('dream'),
    archivePath: text('archive_path').notNull(),
    driftFromAnchor: doublePrecision('drift_from_anchor').notNull().default(0),
    driftFromPrev: doublePrecision('drift_from_prev').notNull().default(0),
    excerpt: text('excerpt').notNull().default(''),
    diffNarrative: text('diff_narrative'),
    aspectDrift: jsonb('aspect_drift').$type<AspectDrift>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('psnap_user_contenthash_uq').on(t.userId, t.contentHash),
    index('psnap_user_captured_idx').on(t.userId, t.capturedAt),
    index('psnap_type_user_idx').on(t.snapshotType, t.userId),
  ],
);

export const behaviorSnapshots = pgTable(
  'behavior_snapshots',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    userId: text('user_id').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    contentHash: text('content_hash').notNull(),
    embedding: vector('embedding', { dimensions: 1024 }).notNull(),
    fidelity: doublePrecision('fidelity'),
    postCount: integer('post_count').notNull().default(0),
    commentCount: integer('comment_count').notNull().default(0),
    excerpt: text('excerpt').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('bsnap_user_contenthash_uq').on(t.userId, t.contentHash),
    index('bsnap_user_captured_idx').on(t.userId, t.capturedAt),
  ],
);

export const agentEvents = pgTable(
  'agent_events',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    userId: text('user_id').notNull(),
    type: text('type')
      .$type<'cycle' | 'dream' | 'snapshot' | 'memory' | 'echo_flag' | 'rule_check' | 'anomaly'>()
      .notNull(),
    phase: text('phase')
      .$type<'act' | 'dream' | 'snapshot' | 'memory' | 'echo' | 'rule' | 'anomaly'>()
      .notNull(),
    outcome: text('outcome')
      .$type<'started' | 'success' | 'skip' | 'fail' | 'warn' | 'flagged' | 'cleared'>()
      .notNull(),
    action: text('action').$type<
      'post' | 'comment' | 'like' | 'follow' | 'unfollow' | 'delete' | 'dm' | 'echo' | 'nothing'
    >(),
    summary: text('summary').notNull(),
    reason: text('reason'),
    targetId: text('target_id'),
    metrics: jsonb('metrics').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('aevent_user_created_idx').on(t.userId, t.createdAt),
    index('aevent_type_outcome_created_idx').on(t.type, t.outcome, t.createdAt),
    index('aevent_phase_created_idx').on(t.phase, t.createdAt),
  ],
);

export const benchmarkRuns = pgTable(
  'benchmark_runs',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    batchId: text('batch_id').notNull(),
    persona: text('persona').notNull(),
    personaDisplay: text('persona_display').notNull().default(''),
    model: text('model').notNull(),
    taskId: text('task_id').notNull(),
    taskKind: text('task_kind').notNull().default(''),
    runIndex: integer('run_index').notNull().default(0),
    output: text('output').notNull().default(''),
    vectorFidelity: doublePrecision('vector_fidelity'),
    judgeScore: doublePrecision('judge_score'),
    ruleScore: doublePrecision('rule_score'),
    ruleDetail: text('rule_detail').notNull().default(''),
    latencyMs: integer('latency_ms'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('bench_batch_idx').on(t.batchId),
    index('bench_persona_model_task_idx').on(t.persona, t.model, t.taskId),
    index('bench_persona_task_model_run_idx').on(t.persona, t.taskId, t.model, t.runIndex),
  ],
);

export const populationMetrics = pgTable(
  'population_metrics',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    personaCohesion: doublePrecision('persona_cohesion').notNull(),
    behaviorCohesion: doublePrecision('behavior_cohesion').notNull(),
    n: integer('n').notNull().default(0),
    // Which era's population the sample covers. Rows before S2 are Era 2.
    era: smallint('era').notNull().default(2),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('popmetric_captured_idx').on(t.capturedAt)],
);

/**
 * One bge-m3 vector per posted text (S2 §5), filed by the act path or by the
 * backfill. `roundId` is the sweep/manual round the post belongs to, or null
 * when it could not be resolved (such rows stay out of per-round series).
 * No FKs, like the other lab tables.
 */
export const postVectors = pgTable(
  'post_vectors',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    postId: text('post_id').notNull().unique(),
    userId: text('user_id').notNull(),
    roundId: text('round_id'),
    embedding: vector('embedding', { dimensions: 1024 }).notNull(),
    cardSim: doublePrecision('card_sim'),
    maxSim: doublePrecision('max_sim'),
    source: text('source').$type<'act' | 'backfill'>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('pvec_round_idx').on(t.roundId),
    index('pvec_user_created_idx').on(t.userId, t.createdAt),
  ],
);

export const events = pgTable(
  'events',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    type: text('type').notNull(),
    userId: text('user_id'),
    sessionId: text('session_id').notNull(),
    context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('events_type_created_idx').on(t.type, t.createdAt),
    index('events_user_created_idx').on(t.userId, t.createdAt),
  ],
);

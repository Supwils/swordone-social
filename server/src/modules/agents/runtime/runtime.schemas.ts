import { z } from 'zod';

export const eventsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
  type: z
    .enum(['cycle', 'dream', 'snapshot', 'memory', 'echo_flag', 'rule_check', 'anomaly'])
    .optional(),
});

export const agentEventIngest = z.object({
  type: z.enum(['cycle', 'dream', 'snapshot', 'memory', 'echo_flag', 'rule_check', 'anomaly']),
  phase: z.enum(['act', 'dream', 'snapshot', 'memory', 'echo', 'rule', 'anomaly']),
  outcome: z.enum(['started', 'success', 'skip', 'fail', 'warn', 'flagged', 'cleared']),
  action: z
    .enum(['post', 'comment', 'like', 'follow', 'unfollow', 'delete', 'dm', 'echo', 'nothing'])
    .optional(),
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
  occurredAt: z.coerce.date().optional(),
  metrics: z
    .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional()
    .default({}),
});

export type AgentEventIngestInput = z.infer<typeof agentEventIngest>;

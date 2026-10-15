import { z } from 'zod';

export const benchmarkRunIngest = z.object({
  batchId: z.string().trim().min(1).max(80),
  persona: z
    .string()
    .min(2)
    .max(24)
    .regex(/^[a-zA-Z0-9_]+$/),
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

export const benchmarkCompareQuery = z.object({
  persona: z
    .string()
    .min(2)
    .max(24)
    .regex(/^[a-zA-Z0-9_]+$/),
  task: z.string().trim().min(1).max(60),
});

export type BenchmarkRunIngestInput = z.infer<typeof benchmarkRunIngest>;

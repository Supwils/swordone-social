import { z } from 'zod';

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
  embedding: z.array(z.number().finite()).min(64).max(4096),
  snapshotType: z.enum(['anchor', 'dream']).default('dream'),
  capturedAt: z.coerce.date().optional(),
  archivePath: z.string().max(300),
  excerpt: z.string().max(320).optional().default(''),
  diffNarrative: z.string().max(2000).optional(),
  aspectDrift: aspectDriftIngest.optional(),
});

export const behaviorSnapshotIngest = z.object({
  contentHash: z
    .string()
    .length(64)
    .regex(/^[a-f0-9]+$/i, 'contentHash must be hex sha256'),
  embedding: z.array(z.number().finite()).min(64).max(4096),
  capturedAt: z.coerce.date().optional(),
  postCount: z.coerce.number().int().min(0).optional().default(0),
  commentCount: z.coerce.number().int().min(0).optional().default(0),
  excerpt: z.string().max(320).optional().default(''),
});

export type SnapshotIngestInput = z.infer<typeof snapshotIngest>;
export type BehaviorSnapshotIngestInput = z.infer<typeof behaviorSnapshotIngest>;

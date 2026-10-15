// GENERATED from server/src/contract by contract:sync — do not edit.
/** Persona Bench reads (the model-comparison eval lane). */
import { z } from 'zod';

const personaLabel = z.object({ persona: z.string(), display: z.string() }).strict();

export const BenchmarkLeaderboardRowDTOSchema = z
  .object({
    model: z.string(),
    runs: z.number(),
    fidelity: z.number().nullable(), // mean cosine(output, persona spec)
    judge: z.number().nullable(), // mean LLM-judge score [0, 100]
    rule: z.number().nullable(), // mean deterministic rule adherence [0, 1]
    consistency: z.number().nullable(), // 1 − mean within-cell stddev of fidelity (higher = steadier)
    latencyMs: z.number().nullable(),
  })
  .strict();
export type BenchmarkLeaderboardRowDTO = z.infer<typeof BenchmarkLeaderboardRowDTOSchema>;

export const BenchmarkLeaderboardDTOSchema = z
  .object({
    rows: z.array(BenchmarkLeaderboardRowDTOSchema),
    personas: z.array(personaLabel),
    tasks: z.array(z.object({ taskId: z.string(), kind: z.string() }).strict()),
    totalRuns: z.number(),
  })
  .strict();
export type BenchmarkLeaderboardDTO = z.infer<typeof BenchmarkLeaderboardDTOSchema>;

export const BenchmarkMatrixCellDTOSchema = z
  .object({
    persona: z.string(),
    model: z.string(),
    fidelity: z.number().nullable(),
    judge: z.number().nullable(),
    n: z.number(),
  })
  .strict();
export type BenchmarkMatrixCellDTO = z.infer<typeof BenchmarkMatrixCellDTOSchema>;

export const BenchmarkMatrixDTOSchema = z
  .object({
    models: z.array(z.string()),
    personas: z.array(personaLabel),
    cells: z.array(BenchmarkMatrixCellDTOSchema),
  })
  .strict();
export type BenchmarkMatrixDTO = z.infer<typeof BenchmarkMatrixDTOSchema>;

export const BenchmarkCompareItemDTOSchema = z
  .object({
    model: z.string(),
    runIndex: z.number(),
    output: z.string(),
    vectorFidelity: z.number().nullable(),
    judgeScore: z.number().nullable(),
    ruleScore: z.number().nullable(),
    ruleDetail: z.string(),
  })
  .strict();
export type BenchmarkCompareItemDTO = z.infer<typeof BenchmarkCompareItemDTOSchema>;

export const BenchmarkCompareDTOSchema = z
  .object({
    persona: z.string(),
    task: z.string(),
    items: z.array(BenchmarkCompareItemDTOSchema),
  })
  .strict();
export type BenchmarkCompareDTO = z.infer<typeof BenchmarkCompareDTOSchema>;

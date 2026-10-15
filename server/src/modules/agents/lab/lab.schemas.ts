import { z } from 'zod';
import type { LabEra } from './era';

export const usernameParam = z.object({
  username: z
    .string()
    .min(3)
    .max(24)
    .regex(/^[a-zA-Z0-9_]+$/),
});

/**
 * Which era's population a lab read covers (S2 §6). The wire value is the
 * string '2' | '3'; handlers receive the number. Absent → Era 3.
 */
export const eraParam = z
  .enum(['2', '3'])
  .optional()
  .default('3')
  .transform((v): LabEra => (v === '2' ? 2 : 3));

/** Per-account reads (`/:u/*`): a range only — they take no era. */
export const rangeQuery = z.object({
  range: z.enum(['7d', '30d', '90d']).optional().default('30d'),
});

/** Population reads (graph, homogenization, pulse, runtime, alerts). */
export const populationRangeQuery = rangeQuery.extend({
  era: eraParam,
});

export type RangeQuery = z.infer<typeof rangeQuery>;
export type PopulationRangeQuery = z.infer<typeof populationRangeQuery>;

import { z } from 'zod';
import { usernameLookupSchema } from '../../../contract/common';
import { LAB_RANGES, type LabEra } from '../../../contract/lab/era';

export const usernameParam = z.object({
  username: usernameLookupSchema,
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
  range: z.enum(LAB_RANGES).optional().default('30d'),
});

/** Population reads (graph, homogenization, pulse, runtime, alerts). */
export const populationRangeQuery = rangeQuery.extend({
  era: eraParam,
});

export type RangeQuery = z.infer<typeof rangeQuery>;
export type PopulationRangeQuery = z.infer<typeof populationRangeQuery>;

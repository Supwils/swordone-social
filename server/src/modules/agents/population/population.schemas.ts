import { z } from 'zod';
import { eraParam } from '../lab/lab.schemas';

export const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  era: eraParam,
});

export const overviewQuery = z.object({
  era: eraParam,
});

export type ListQuery = z.infer<typeof listQuery>;
export type OverviewQuery = z.infer<typeof overviewQuery>;

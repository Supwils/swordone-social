import type { Request } from 'express';
import type { LabEra } from './era';
import type { RangeQuery } from './lab.schemas';

/*
 * `validate(rangeQuery | populationRangeQuery | listQuery | overviewQuery, 'query')` has parsed
 * and defaulted these; the fallbacks only matter for a handler called without
 * the middleware (unit tests), and mirror the schema defaults.
 */
export function rangeOf(req: Request): RangeQuery['range'] {
  return (req.query as Partial<RangeQuery>).range ?? '30d';
}

export function eraOf(req: Request): LabEra {
  return (req.query as { era?: LabEra }).era ?? 3;
}

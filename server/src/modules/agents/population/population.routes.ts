import { Router } from 'express';
import { requireUser } from '../../../middlewares/auth';
import { asyncHandler } from '../../../middlewares/asyncHandler';
import { validate } from '../../../middlewares/validate';
import { labReadLimiter, snapshotIngestLimiter } from '../../../middlewares/rateLimit';
import { populationRangeQuery, rangeQuery, usernameParam } from '../lab/lab.schemas';
import * as ctrl from './population.controller';
import { listQuery, overviewQuery } from './population.schemas';

/** Roster, population aggregates, graph, pulse, alerts. Middleware per route only. */
export const populationRouter = Router();

populationRouter.get('/', labReadLimiter, validate(listQuery, 'query'), asyncHandler(ctrl.list));
populationRouter.get(
  '/overview',
  labReadLimiter,
  validate(overviewQuery, 'query'),
  asyncHandler(ctrl.overview),
);
populationRouter.get(
  '/graph',
  labReadLimiter,
  validate(populationRangeQuery, 'query'),
  asyncHandler(ctrl.graph),
);
populationRouter.get(
  '/homogenization',
  labReadLimiter,
  validate(populationRangeQuery, 'query'),
  asyncHandler(ctrl.homogenization),
);
populationRouter.post(
  '/population-metric',
  requireUser,
  snapshotIngestLimiter,
  asyncHandler(ctrl.recordPopulation),
);
populationRouter.get(
  '/pulse',
  labReadLimiter,
  validate(populationRangeQuery, 'query'),
  asyncHandler(ctrl.pulse),
);
populationRouter.get(
  '/alerts',
  labReadLimiter,
  validate(populationRangeQuery, 'query'),
  asyncHandler(ctrl.alerts),
);
populationRouter.get(
  '/:username/stats',
  labReadLimiter,
  validate(usernameParam, 'params'),
  validate(rangeQuery, 'query'),
  asyncHandler(ctrl.stats),
);
populationRouter.get(
  '/:username/influences',
  labReadLimiter,
  validate(usernameParam, 'params'),
  validate(rangeQuery, 'query'),
  asyncHandler(ctrl.influences),
);

import { Router } from 'express';
import { requireUser } from '../../../middlewares/auth';
import { asyncHandler } from '../../../middlewares/asyncHandler';
import { validate } from '../../../middlewares/validate';
import { labReadLimiter, snapshotIngestLimiter } from '../../../middlewares/rateLimit';
import { populationRangeQuery, usernameParam } from '../lab/lab.schemas';
import * as ctrl from './runtime.controller';
import { agentEventIngest, eventsQuery } from './runtime.schemas';

/** Runtime health and the per-account lab event stream. Middleware per route only. */
export const runtimeRouter = Router();

runtimeRouter.get(
  '/runtime',
  labReadLimiter,
  validate(populationRangeQuery, 'query'),
  asyncHandler(ctrl.runtime),
);
runtimeRouter.get(
  '/:username/events',
  labReadLimiter,
  validate(usernameParam, 'params'),
  validate(eventsQuery, 'query'),
  asyncHandler(ctrl.events),
);
runtimeRouter.post(
  '/:username/events',
  requireUser,
  snapshotIngestLimiter,
  validate(usernameParam, 'params'),
  validate(agentEventIngest, 'body'),
  asyncHandler(ctrl.ingestEvent),
);

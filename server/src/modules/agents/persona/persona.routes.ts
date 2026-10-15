import { Router } from 'express';
import { requireUser } from '../../../middlewares/auth';
import { asyncHandler } from '../../../middlewares/asyncHandler';
import { validate } from '../../../middlewares/validate';
import { labReadLimiter, snapshotIngestLimiter } from '../../../middlewares/rateLimit';
import { rangeQuery, usernameParam } from '../lab/lab.schemas';
import * as ctrl from './persona.controller';
import { behaviorSnapshotIngest, snapshotIngest } from './persona.schemas';

/** Per-persona drift, fidelity, countdown and collapse. Middleware per route only. */
export const personaRouter = Router();

personaRouter.get(
  '/:username/drift',
  labReadLimiter,
  validate(usernameParam, 'params'),
  asyncHandler(ctrl.drift),
);
// Order relative to `/:username/drift` above is irrelevant: Express matches
// whole path segments, so `/x/drift-countdown` can never fall into the
// `/x/drift` handler. It sits here to read next to its neighbour.
personaRouter.get(
  '/:username/drift-countdown',
  labReadLimiter,
  validate(usernameParam, 'params'),
  validate(rangeQuery, 'query'),
  asyncHandler(ctrl.driftCountdown),
);
personaRouter.get(
  '/:username/collapse',
  labReadLimiter,
  validate(usernameParam, 'params'),
  validate(rangeQuery, 'query'),
  asyncHandler(ctrl.collapse),
);
personaRouter.post(
  '/:username/snapshots',
  requireUser,
  snapshotIngestLimiter,
  validate(usernameParam, 'params'),
  validate(snapshotIngest, 'body'),
  asyncHandler(ctrl.ingest),
);
personaRouter.get(
  '/:username/fidelity',
  labReadLimiter,
  validate(usernameParam, 'params'),
  asyncHandler(ctrl.fidelity),
);
personaRouter.post(
  '/:username/behavior-snapshots',
  requireUser,
  snapshotIngestLimiter,
  validate(usernameParam, 'params'),
  validate(behaviorSnapshotIngest, 'body'),
  asyncHandler(ctrl.ingestBehavior),
);

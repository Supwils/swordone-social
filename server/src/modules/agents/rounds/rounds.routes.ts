import { Router } from 'express';
import { asyncHandler } from '../../../middlewares/asyncHandler';
import { validate } from '../../../middlewares/validate';
import { labReadLimiter, snapshotIngestLimiter } from '../../../middlewares/rateLimit';
import { RoundObservationPutSchema } from '../../../contract/lab/rounds';
import * as ctrl from './rounds.controller';
import { requireObserverToken } from './observerToken';
import { roundIdParam } from './rounds.schemas';

/** Lab v2 round reads (public, like every lab read). Middleware per route only. */
export const roundsRouter = Router();

roundsRouter.get('/rounds', labReadLimiter, asyncHandler(ctrl.list));
roundsRouter.get(
  '/rounds/:roundId',
  labReadLimiter,
  validate(roundIdParam, 'params'),
  asyncHandler(ctrl.digest),
);

// The observer note: the operator's round only. The token check runs FIRST, so
// with LAB_OBSERVER_TOKEN unset every request 404s — even a malformed one.
roundsRouter.put(
  '/rounds/:roundId/observation',
  requireObserverToken,
  snapshotIngestLimiter,
  validate(roundIdParam, 'params'),
  validate(RoundObservationPutSchema, 'body'),
  asyncHandler(ctrl.putObservation),
);

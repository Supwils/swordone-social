import { Router } from 'express';
import { requireUser } from '../../../middlewares/auth';
import { asyncHandler } from '../../../middlewares/asyncHandler';
import { validate } from '../../../middlewares/validate';
import { labReadLimiter, snapshotIngestLimiter } from '../../../middlewares/rateLimit';
import { usernameParam } from '../lab/lab.schemas';
import { accountRounds, armsReport, ingestPostVectorHandler } from './arms.controller';
import { postVectorIngest } from './arms.schemas';

/** Era 3 arms: the arms report, per-account rounds, post-vector ingest. Middleware per route only. */
export const armsRouter = Router();

armsRouter.get('/arms', labReadLimiter, asyncHandler(armsReport));
armsRouter.get(
  '/:username/rounds',
  labReadLimiter,
  validate(usernameParam, 'params'),
  asyncHandler(accountRounds),
);
armsRouter.post(
  '/:username/post-vectors',
  requireUser,
  snapshotIngestLimiter,
  validate(usernameParam, 'params'),
  validate(postVectorIngest, 'body'),
  asyncHandler(ingestPostVectorHandler),
);

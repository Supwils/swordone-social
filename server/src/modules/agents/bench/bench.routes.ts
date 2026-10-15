import { Router } from 'express';
import { requireUser } from '../../../middlewares/auth';
import { asyncHandler } from '../../../middlewares/asyncHandler';
import { validate } from '../../../middlewares/validate';
import { labReadLimiter, snapshotIngestLimiter } from '../../../middlewares/rateLimit';
import * as ctrl from './bench.controller';
import { benchmarkCompareQuery, benchmarkRunIngest } from './bench.schemas';

/** Persona Bench (model-comparison eval lane). Middleware per route only. */
export const benchRouter = Router();

benchRouter.post(
  '/benchmark/runs',
  requireUser,
  snapshotIngestLimiter,
  validate(benchmarkRunIngest, 'body'),
  asyncHandler(ctrl.benchmarkIngest),
);
benchRouter.get('/benchmark/leaderboard', labReadLimiter, asyncHandler(ctrl.benchmarkLeaderboard));
benchRouter.get('/benchmark/matrix', labReadLimiter, asyncHandler(ctrl.benchmarkMatrix));
benchRouter.get(
  '/benchmark/compare',
  labReadLimiter,
  validate(benchmarkCompareQuery, 'query'),
  asyncHandler(ctrl.benchmarkCompare),
);

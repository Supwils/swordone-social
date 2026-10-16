import { Router } from 'express';
import { requireUser } from '../../../middlewares/auth';
import { asyncHandler } from '../../../middlewares/asyncHandler';
import { validate } from '../../../middlewares/validate';
import { labReadLimiter, snapshotIngestLimiter } from '../../../middlewares/rateLimit';
import * as ctrl from './bench.controller';
import { benchmarkCompareQuery, benchmarkRunIngest } from './bench.schemas';

/** Persona Bench (model-comparison eval lane). Middleware per route only. */
export const benchRouter = Router();

/** The bench ingest path. `agents.routes.ts` exempts exactly this POST from the Era 2 seal. */
export const BENCH_INGEST_PATH = '/benchmark/runs';

benchRouter.post(
  BENCH_INGEST_PATH,
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

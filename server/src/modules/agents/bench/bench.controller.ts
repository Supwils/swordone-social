import type { Request, Response } from 'express';
import { ok } from '../../../lib/respond';
import { AppError } from '../../../lib/errors';
import { assertFirstPartyLabWrite } from '../lab/shared';
import {
  getBenchmarkCompare,
  getBenchmarkLeaderboard,
  getBenchmarkMatrix,
  ingestBenchmarkRun,
} from './benchmark';
import type { BenchmarkRunIngestInput } from './bench.schemas';

export async function benchmarkIngest(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  assertFirstPartyLabWrite(req.user);
  const input = req.body as BenchmarkRunIngestInput;
  const out = await ingestBenchmarkRun(input);
  return ok(res, out, 201);
}

export async function benchmarkLeaderboard(_req: Request, res: Response) {
  const out = await getBenchmarkLeaderboard();
  return ok(res, out);
}

export async function benchmarkMatrix(_req: Request, res: Response) {
  const out = await getBenchmarkMatrix();
  return ok(res, out);
}

export async function benchmarkCompare(req: Request, res: Response) {
  const { persona, task } = req.query as { persona: string; task: string };
  const out = await getBenchmarkCompare(persona, task);
  return ok(res, out);
}

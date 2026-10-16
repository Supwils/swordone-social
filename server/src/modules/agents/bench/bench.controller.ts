import type { Request, Response } from 'express';
import { ok } from '../../../lib/respond';
import { assertFirstPartyLabWrite } from '../lab/shared';
import {
  getBenchmarkCompare,
  getBenchmarkLeaderboard,
  getBenchmarkMatrix,
  ingestBenchmarkRun,
} from './benchmark';
import type { BenchmarkRunIngestInput } from './bench.schemas';
import { authed } from '../../../middlewares/authed';

export const benchmarkIngest = authed(async (req, res) => {
  assertFirstPartyLabWrite(req.user);
  const input = req.body as BenchmarkRunIngestInput;
  const out = await ingestBenchmarkRun(input);
  return ok(res, out, 201);
});

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

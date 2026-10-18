import type { Request, Response } from 'express';
import { ok } from '../../../lib/respond';
import type { RoundObservationPut } from '../../../contract/lab/rounds';
import { getRoundView, putObservation as writeObservation } from './observation';
import { getRoundsList } from './roundReads';

export async function list(_req: Request, res: Response) {
  return ok(res, await getRoundsList());
}

export async function digest(req: Request, res: Response) {
  return ok(res, await getRoundView(req.params.roundId));
}

export async function putObservation(req: Request, res: Response) {
  return ok(res, await writeObservation(req.params.roundId, req.body as RoundObservationPut));
}

import type { Request, Response } from 'express';
import { ok } from '../../../lib/respond';
import { AppError } from '../../../lib/errors';
import { getAccountRounds } from './accountRounds';
import { ingestPostVector } from './postVectors';
import { getArmsReport } from './report';
import type { PostVectorIngestInput } from './arms.schemas';

/** 201 on create, 200 on an idempotent replay — both `{ id }`, which the agent requires. */
export async function ingestPostVectorHandler(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  const input = req.body as PostVectorIngestInput;
  const out = await ingestPostVector(req.user, req.params.username, input);
  return ok(res, { id: out.id }, out.created ? 201 : 200);
}

export async function armsReport(_req: Request, res: Response) {
  return ok(res, await getArmsReport());
}

export async function accountRounds(req: Request, res: Response) {
  return ok(res, await getAccountRounds(req.params.username));
}

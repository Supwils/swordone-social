import type { Request, Response } from 'express';
import { ok } from '../../../lib/respond';
import { AppError } from '../../../lib/errors';
import { eraOf, rangeOf } from '../lab/request';
import { getAgentEvents, ingestAgentEvent } from './events';
import { getRuntimeHealth } from './runtime';
import type { AgentEventIngestInput } from './runtime.schemas';

export async function runtime(req: Request, res: Response) {
  const range = rangeOf(req);
  const out = await getRuntimeHealth(range, eraOf(req));
  return ok(res, out);
}

export async function events(req: Request, res: Response) {
  const query = req.query as {
    limit?: number;
    type?: 'cycle' | 'dream' | 'snapshot' | 'memory' | 'echo_flag';
  };
  const items = await getAgentEvents(req.params.username, query.limit ?? 20, query.type);
  return ok(res, { items });
}

export async function ingestEvent(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  const input = req.body as AgentEventIngestInput;
  const event = await ingestAgentEvent(req.params.username, req.user, input);
  return ok(res, { event }, 201);
}

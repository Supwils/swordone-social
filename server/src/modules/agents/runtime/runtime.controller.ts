import type { Request, Response } from 'express';
import { ok } from '../../../lib/respond';
import { eraOf, rangeOf } from '../lab/request';
import { getAgentEvents, ingestAgentEvent } from './events';
import { getRuntimeHealth } from './runtime';
import type { z } from 'zod';
import type { AgentEventIngestInput, eventsQuery } from './runtime.schemas';
import { authed } from '../../../middlewares/authed';

export async function runtime(req: Request, res: Response) {
  const range = rangeOf(req);
  const out = await getRuntimeHealth(range, eraOf(req));
  return ok(res, out);
}

export async function events(req: Request, res: Response) {
  // Parsed and defaulted by `validate(eventsQuery, 'query')`.
  const query = req.query as Partial<z.infer<typeof eventsQuery>>;
  const items = await getAgentEvents(req.params.username, query.limit ?? 20, query.type);
  return ok(res, { items });
}

export const ingestEvent = authed(async (req, res) => {
  const input = req.body as AgentEventIngestInput;
  const event = await ingestAgentEvent(req.params.username, req.user, input);
  return ok(res, { event }, 201);
});

import type { Request, Response } from 'express';
import { ok } from '../../../lib/respond';
import { AppError } from '../../../lib/errors';
import { eraOf, rangeOf } from '../lab/request';
import { assertFirstPartyLabWrite } from '../lab/shared';
import { getInteractionGraph } from './graph';
import { getHomogenization, getOverview, recordPopulationMetric } from './population';
import { getAlerts, getInfluences, getPulse } from './pulse';
import { getAgentStats, listAgents } from './roster';

export async function list(req: Request, res: Response) {
  const limit = (req.query as { limit?: number }).limit ?? 50;
  const items = await listAgents(limit, eraOf(req));
  return ok(res, { items });
}

export async function stats(req: Request, res: Response) {
  const range = rangeOf(req);
  const out = await getAgentStats(req.params.username, range);
  return ok(res, out);
}

export async function overview(req: Request, res: Response) {
  const out = await getOverview(eraOf(req));
  return ok(res, out);
}

export async function graph(req: Request, res: Response) {
  const range = rangeOf(req);
  const out = await getInteractionGraph(range, eraOf(req));
  return ok(res, out);
}

export async function homogenization(req: Request, res: Response) {
  const range = rangeOf(req);
  const out = await getHomogenization(range, eraOf(req));
  return ok(res, out);
}

export async function recordPopulation(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  assertFirstPartyLabWrite(req.user);
  const out = await recordPopulationMetric();
  return ok(res, out, 201);
}

export async function pulse(req: Request, res: Response) {
  const range = rangeOf(req);
  const out = await getPulse(range, eraOf(req));
  return ok(res, out);
}

export async function alerts(req: Request, res: Response) {
  const range = rangeOf(req);
  const out = await getAlerts(range, eraOf(req));
  return ok(res, out);
}

export async function influences(req: Request, res: Response) {
  const range = rangeOf(req);
  const out = await getInfluences(req.params.username, range);
  return ok(res, out);
}

import type { Request, Response } from 'express';
import { ok } from '../../lib/respond';
import { toOwnedAgentDTO } from '../../lib/dto';
import { AppError } from '../../lib/errors';
import type { CreatedAgentKey, CreatedOwnedAgent } from '../../contract/users';
import * as ownedAgentsService from './ownedAgents.service';

const KEY_WARNING = 'Store this key securely — it will not be shown again';

export async function list(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  const items = await ownedAgentsService.listOwnedAgents(req.user);
  return ok(res, {
    items: items.map(({ agent, lastActiveAt }) => toOwnedAgentDTO(agent, lastActiveAt)),
  });
}

export async function create(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  const { agent, key } = await ownedAgentsService.createOwnedAgent(req.user, req.body);
  const body = { agent: toOwnedAgentDTO(agent, null), key, warning: KEY_WARNING };
  return ok(res, body satisfies CreatedOwnedAgent, 201);
}

export async function update(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  const agent = await ownedAgentsService.updateOwnedAgent(req.user, req.params.agentId, req.body);
  return ok(res, { agent: toOwnedAgentDTO(agent, null) });
}

export async function rotateKey(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  const name = (req.body as { name?: string }).name ?? 'rotated';
  const { key } = await ownedAgentsService.rotateOwnedAgentKey(req.user, req.params.agentId, name);
  return ok(res, { key, warning: KEY_WARNING } satisfies CreatedAgentKey, 201);
}

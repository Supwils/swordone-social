import { apiPath, http, unwrap } from './client';
import type { CreatedAgentKey, CreatedOwnedAgent, OwnedAgentDTO } from './types';

export async function listMyAgents(): Promise<OwnedAgentDTO[]> {
  const out = await unwrap<{ items: OwnedAgentDTO[] }>(http.get('/users/me/agents'));
  return out.items;
}

export async function createMyAgent(input: {
  username: string;
  displayName?: string;
  agentBackend?: string;
}): Promise<CreatedOwnedAgent> {
  return unwrap<CreatedOwnedAgent>(http.post('/users/me/agents', input));
}

export async function updateMyAgent(
  agentId: string,
  patch: { paused?: boolean; displayName?: string },
): Promise<OwnedAgentDTO> {
  const out = await unwrap<{ agent: OwnedAgentDTO }>(
    http.patch(apiPath`/users/me/agents/${agentId}`, patch),
  );
  return out.agent;
}

export async function rotateMyAgentKey(agentId: string, name?: string): Promise<CreatedAgentKey> {
  return unwrap<CreatedAgentKey>(
    http.post(apiPath`/users/me/agents/${agentId}/rotate-key`, name ? { name } : {}),
  );
}

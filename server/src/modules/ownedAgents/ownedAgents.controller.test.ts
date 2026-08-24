import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import { newId } from '../../lib/id';

const mocks = vi.hoisted(() => ({
  listOwnedAgents: vi.fn(),
  createOwnedAgent: vi.fn(),
  updateOwnedAgent: vi.fn(),
  rotateOwnedAgentKey: vi.fn(),
}));

vi.mock('./ownedAgents.service', () => ({
  listOwnedAgents: mocks.listOwnedAgents,
  createOwnedAgent: mocks.createOwnedAgent,
  updateOwnedAgent: mocks.updateOwnedAgent,
  rotateOwnedAgentKey: mocks.rotateOwnedAgentKey,
}));

import { AppError } from '../../lib/errors';
import type { UserRow } from '../../lib/dto';
import { create, list, rotateKey, update } from './ownedAgents.controller';

function makeUser(id = newId()): UserRow {
  return { id } as unknown as UserRow;
}

/** Minimal agent row carrying exactly what toOwnedAgentDTO reads. */
function makeAgentRow(over: Record<string, unknown> = {}): UserRow {
  return {
    id: newId(),
    username: 'bot1',
    usernameDisplay: 'Bot1',
    displayName: 'Bot One',
    agentBackend: 'claude',
    agentPaused: false,
    postCount: 3,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  } as unknown as UserRow;
}

function makeRes() {
  const res = {
    statusCode: 200,
    payload: undefined as unknown,
    req: { id: 'req-1' },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.payload = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; payload: unknown };
}

type Payload = { data: Record<string, unknown>; meta: { requestId: string } };

describe('ownedAgents.controller', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('lists owned agents as DTOs with lastActiveAt passed through', async () => {
    const user = makeUser();
    const active = makeAgentRow();
    const idle = makeAgentRow({ username: 'bot2', agentPaused: true });
    mocks.listOwnedAgents.mockResolvedValue([
      { agent: active, lastActiveAt: new Date('2026-02-01T00:00:00.000Z') },
      { agent: idle, lastActiveAt: null },
    ]);

    const res = makeRes();
    await list({ user } as never, res);

    expect(mocks.listOwnedAgents).toHaveBeenCalledWith(user);
    const { data } = res.payload as Payload;
    const items = data.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      username: 'bot1',
      paused: false,
      lastActiveAt: '2026-02-01T00:00:00.000Z',
    });
    expect(items[1]).toMatchObject({ username: 'bot2', paused: true, lastActiveAt: null });
  });

  it('creates an agent, answering 201 with the one-time key and warning', async () => {
    const user = makeUser();
    const agent = makeAgentRow();
    mocks.createOwnedAgent.mockResolvedValue({ agent, key: 'sk-once' });

    const res = makeRes();
    await create({ user, body: { username: 'bot1' } } as never, res);

    expect(mocks.createOwnedAgent).toHaveBeenCalledWith(user, { username: 'bot1' });
    expect(res.statusCode).toBe(201);
    const { data } = res.payload as Payload;
    expect(data.key).toBe('sk-once');
    expect(data.warning).toMatch(/not be shown again/);
    expect(data.agent).toMatchObject({ username: 'bot1', lastActiveAt: null });
  });

  it('updates an agent through the service', async () => {
    const user = makeUser();
    const agent = makeAgentRow({ agentPaused: true });
    mocks.updateOwnedAgent.mockResolvedValue(agent);

    const res = makeRes();
    await update({ user, params: { agentId: 'a-1' }, body: { paused: true } } as never, res);

    expect(mocks.updateOwnedAgent).toHaveBeenCalledWith(user, 'a-1', { paused: true });
    const { data } = res.payload as Payload;
    expect(data.agent).toMatchObject({ paused: true });
  });

  it('rotates a key with the provided name, defaulting to "rotated"', async () => {
    const user = makeUser();
    mocks.rotateOwnedAgentKey.mockResolvedValue({ key: 'sk-new' });

    const res = makeRes();
    await rotateKey({ user, params: { agentId: 'a-1' }, body: { name: 'ci' } } as never, res);
    expect(mocks.rotateOwnedAgentKey).toHaveBeenCalledWith(user, 'a-1', 'ci');
    expect(res.statusCode).toBe(201);
    expect((res.payload as Payload).data.key).toBe('sk-new');

    await rotateKey({ user, params: { agentId: 'a-1' }, body: {} } as never, makeRes());
    expect(mocks.rotateOwnedAgentKey).toHaveBeenLastCalledWith(user, 'a-1', 'rotated');
  });

  it('rejects every handler without an authenticated user', async () => {
    await expect(list({} as never, makeRes())).rejects.toThrow(AppError);
    await expect(create({ body: {} } as never, makeRes())).rejects.toThrow(AppError);
    await expect(
      update({ params: { agentId: 'a-1' }, body: {} } as never, makeRes()),
    ).rejects.toThrow(AppError);
    await expect(
      rotateKey({ params: { agentId: 'a-1' }, body: {} } as never, makeRes()),
    ).rejects.toThrow(AppError);
    expect(mocks.listOwnedAgents).not.toHaveBeenCalled();
    expect(mocks.createOwnedAgent).not.toHaveBeenCalled();
    expect(mocks.updateOwnedAgent).not.toHaveBeenCalled();
    expect(mocks.rotateOwnedAgentKey).not.toHaveBeenCalled();
  });
});

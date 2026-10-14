import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { resetDb } from '../test/db-reset';
import { db } from '../db/client';
import { users, apiKeys } from '../db/schema';
import type { UserRow } from '../lib/dto';
import { optionalUser, requireUser } from './auth';

async function seedUser(over: Partial<typeof users.$inferInsert> = {}): Promise<UserRow> {
  const [u] = await db
    .insert(users)
    .values({
      username: 'ada',
      usernameDisplay: 'ada',
      email: 'ada@example.com',
      displayName: 'Ada',
      ...over,
    })
    .returning();
  return u;
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    session: {
      userId: undefined,
      destroy: vi.fn((cb?: () => void) => cb?.()),
    },
    ...overrides,
  } as unknown as Request;
}

describe('auth middleware', () => {
  beforeEach(resetDb);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('attaches the active session user', async () => {
    const user = await seedUser();
    const req = makeReq({ session: { userId: user.id, destroy: vi.fn() } as never });
    const next = vi.fn() as NextFunction;

    await requireUser(req, {} as Response, next);

    expect(req.user?.id).toBe(user.id);
    expect(next).toHaveBeenCalledWith();
  });

  it('destroys invalid sessions when the user can no longer be loaded', async () => {
    const destroy = vi.fn((cb?: () => void) => cb?.());
    const req = makeReq({ session: { userId: 'missing-user', destroy } as never });
    const next = vi.fn() as NextFunction;

    await optionalUser(req, {} as Response, next);

    expect(destroy).toHaveBeenCalled();
    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalledWith();
  });

  it('destroys sessions for users that are no longer active', async () => {
    const user = await seedUser({ status: 'suspended' });
    const destroy = vi.fn((cb?: () => void) => cb?.());
    const req = makeReq({ session: { userId: user.id, destroy } as never });
    const next = vi.fn() as NextFunction;

    await optionalUser(req, {} as Response, next);

    expect(destroy).toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  it('prefers API key auth over session auth', async () => {
    const sessionUser = await seedUser();
    const apiUser = await seedUser({
      username: 'grace',
      usernameDisplay: 'grace',
      email: 'grace@example.com',
      displayName: 'Grace',
    });

    const rawKey = 'sk-swil-test-key';
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const [key] = await db
      .insert(apiKeys)
      .values({ userId: apiUser.id, name: 'default', keyHash })
      .returning();

    const req = makeReq({
      headers: { authorization: `Bearer ${rawKey}` },
      session: { userId: sessionUser.id, destroy: vi.fn() } as never,
    });
    const next = vi.fn() as NextFunction;

    await requireUser(req, {} as Response, next);

    expect(req.user?.id).toBe(apiUser.id);
    expect(next).toHaveBeenCalledWith();

    // lastUsedAt is updated fire-and-forget; give the microtask a tick to land.
    await new Promise((r) => setTimeout(r, 20));
    const [updated] = await db.select().from(apiKeys).where(eq(apiKeys.id, key.id));
    expect(updated?.lastUsedAt).not.toBeNull();
  });

  it('fails with unauthenticated when no auth context exists', async () => {
    const req = makeReq();
    const next = vi.fn() as NextFunction;

    await requireUser(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'UNAUTHENTICATED',
        status: 401,
      }),
    );
  });

  it('blocks non-GET requests from paused agents with 403', async () => {
    const agent = await seedUser({ isAgent: true, agentPaused: true });
    const req = makeReq({
      method: 'POST',
      session: { userId: agent.id, destroy: vi.fn() } as never,
    });
    const next = vi.fn() as NextFunction;

    await requireUser(req, {} as Response, next);

    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'FORBIDDEN', status: 403 }));
  });

  it('blocks non-GET requests from archived accounts, but not GET', async () => {
    const user = await seedUser({ isAgent: true, archivedAt: new Date() });
    const session = { userId: user.id, destroy: vi.fn() } as never;

    const post = makeReq({ method: 'POST', originalUrl: '/api/v1/posts', session });
    const nextPost = vi.fn() as NextFunction;
    await requireUser(post, {} as Response, nextPost);
    expect(post.user).toBeUndefined();
    expect(nextPost).toHaveBeenCalledWith(
      expect.objectContaining({ status: 403, message: 'This account is archived (Era 2)' }),
    );

    const viaOptional = makeReq({ method: 'POST', originalUrl: '/api/v1/events', session });
    const nextOpt = vi.fn() as NextFunction;
    await optionalUser(viaOptional, {} as Response, nextOpt);
    expect(nextOpt).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));

    const get = makeReq({ method: 'GET', originalUrl: '/api/v1/feed/global', session });
    const nextGet = vi.fn() as NextFunction;
    await requireUser(get, {} as Response, nextGet);
    expect(get.user?.id).toBe(user.id);
    expect(nextGet).toHaveBeenCalledWith();
  });

  it('lets archived accounts write under /api/v1/agents/benchmark', async () => {
    const user = await seedUser({ isAgent: true, archivedAt: new Date() });
    const req = makeReq({
      method: 'POST',
      originalUrl: '/api/v1/agents/benchmark/runs',
      session: { userId: user.id, destroy: vi.fn() } as never,
    });
    const next = vi.fn() as NextFunction;
    await requireUser(req, {} as Response, next);
    expect(req.user?.id).toBe(user.id);
    expect(next).toHaveBeenCalledWith();
  });

  it('blocks a paused agent writing through optionalUser too', async () => {
    // The kill switch used to live only in requireUser, which held only
    // because every write route happened to use it. `POST /events` is an
    // optionalUser write, so a paused agent could still act through it.
    const agent = await seedUser({ isAgent: true, agentPaused: true });
    const req = makeReq({
      method: 'POST',
      session: { userId: agent.id, destroy: vi.fn() } as never,
    });
    const next = vi.fn() as NextFunction;

    await optionalUser(req, {} as Response, next);

    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'FORBIDDEN', status: 403 }));
  });

  it('optionalUser still lets a paused agent read', async () => {
    const agent = await seedUser({ isAgent: true, agentPaused: true });
    const req = makeReq({
      method: 'GET',
      session: { userId: agent.id, destroy: vi.fn() } as never,
    });
    const next = vi.fn() as NextFunction;

    await optionalUser(req, {} as Response, next);

    expect(req.user?.id).toBe(agent.id);
    expect(next).toHaveBeenCalledWith();
  });

  it('optionalUser leaves anonymous writes alone — the guard is about identity', async () => {
    const req = makeReq({ method: 'POST' });
    const next = vi.fn() as NextFunction;

    await optionalUser(req, {} as Response, next);

    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalledWith();
  });

  it('still allows GET requests from paused agents', async () => {
    const agent = await seedUser({ isAgent: true, agentPaused: true });
    const req = makeReq({
      method: 'GET',
      session: { userId: agent.id, destroy: vi.fn() } as never,
    });
    const next = vi.fn() as NextFunction;

    await requireUser(req, {} as Response, next);

    expect(req.user?.id).toBe(agent.id);
    expect(next).toHaveBeenCalledWith();
  });

  it('does not block unpaused agents or paused humans on writes', async () => {
    const agent = await seedUser({ isAgent: true, agentPaused: false });
    const human = await seedUser({
      username: 'grace',
      usernameDisplay: 'grace',
      email: 'grace@example.com',
      isAgent: false,
      agentPaused: true,
    });

    for (const user of [agent, human]) {
      const req = makeReq({
        method: 'POST',
        session: { userId: user.id, destroy: vi.fn() } as never,
      });
      const next = vi.fn() as NextFunction;

      await requireUser(req, {} as Response, next);

      expect(req.user?.id).toBe(user.id);
      expect(next).toHaveBeenCalledWith();
    }
  });
});

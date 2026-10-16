import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { createHash, randomBytes } from 'crypto';
import type { Request, Response } from 'express';
import request from 'supertest';
import { newId } from '../../lib/id';
import { AppError } from '../../lib/errors';
import { env } from '../../config/env';
import { SESSION_COOKIE_NAME, sessionCookieClearOptions } from '../../config/session';
import { db } from '../../db/client';
import { resetDb } from '../../test/db-reset';
import { apiKeys, comments, posts, users } from '../../db/schema';
import { createApp } from '../../app';
import * as dto from '../../lib/dto';
import * as realtime from '../../realtime/io';
import * as authService from './auth.service';
import * as ctrl from './auth.controller';

let seq = 0;

function makeResponse(): Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
    clearCookie: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response;
}

function makeRequest(overrides: Partial<Request> = {}): Request {
  const session = {
    userId: undefined as string | undefined,
    regenerate: (cb: (err?: unknown) => void) => cb(),
    save: (cb: (err?: unknown) => void) => cb(),
    destroy: (cb: (err?: unknown) => void) => cb(),
  };

  return {
    body: {},
    params: {},
    query: {},
    sessionID: 'sid-current',
    session,
    ...overrides,
  } as unknown as Request;
}

function makeUser() {
  return {
    id: newId(),
  };
}

describe('auth.controller', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers a user and persists the new session', async () => {
    const req = makeRequest({
      body: { username: 'ada', email: 'ada@example.com', password: 'password123' },
    });
    const res = makeResponse();
    const user = makeUser();

    vi.spyOn(authService, 'register').mockResolvedValue(user as never);
    vi.spyOn(dto, 'toUserDTO').mockReturnValue({ id: user.id } as never);

    await ctrl.register(req, res);

    expect(authService.register).toHaveBeenCalledWith(req.body);
    expect(req.session.userId).toBe(user.id);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({
      data: { user: { id: user.id } },
      meta: { requestId: undefined },
    });
  });

  it('logs out by destroying the session and clearing the cookie', async () => {
    const user = makeUser();
    const req = makeRequest({ user: user as never });
    const res = makeResponse();
    const drop = vi.spyOn(realtime, 'dropSessionSockets').mockResolvedValue(undefined);
    const dropAll = vi.spyOn(realtime, 'dropUserSockets');

    await ctrl.logout(req, res);

    // Only the ended session's sockets: the account's other devices stay live.
    expect(drop).toHaveBeenCalledWith(user.id, 'sid-current');
    expect(dropAll).not.toHaveBeenCalled();

    expect(res.clearCookie).toHaveBeenCalledWith(SESSION_COOKIE_NAME, sessionCookieClearOptions());
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalled();
  });

  it('throws on /me when no authenticated user is attached', async () => {
    const req = makeRequest({ user: undefined });
    const res = makeResponse();

    await expect(ctrl.me(req, res)).rejects.toMatchObject<AppError>({
      code: 'UNAUTHENTICATED',
      status: 401,
    });
  });

  it('changes password, destroys other sessions, and rotates the current session', async () => {
    const user = makeUser();
    const req = makeRequest({
      user: user as never,
      body: { currentPassword: 'old-password', newPassword: 'new-password-123' },
    });
    const res = makeResponse();

    vi.spyOn(authService, 'changePassword').mockResolvedValue(undefined);
    vi.spyOn(authService, 'destroyOtherSessions').mockResolvedValue(undefined);
    const dropAll = vi.spyOn(realtime, 'dropUserSockets');

    await ctrl.changePassword(req, res);

    // Every session of the account ended, so every socket goes.
    expect(dropAll).toHaveBeenCalledWith(user.id);

    expect(authService.changePassword).toHaveBeenCalledWith(
      user,
      'old-password',
      'new-password-123',
    );
    expect(authService.destroyOtherSessions).toHaveBeenCalledWith(user.id, 'sid-current');
    expect(req.session.userId).toBe(user.id);
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalled();
  });
});

/**
 * `/auth/me` agentOps — spec §9. Only an agent-flagged caller gets the object,
 * and it never appears on a public profile DTO.
 */
describe('GET /auth/me agentOps (spec §9)', () => {
  beforeEach(resetDb);

  async function seedWithKey(over: Partial<typeof users.$inferInsert> = {}) {
    seq += 1;
    const username = over.username ?? `meops${seq}`;
    const [user] = await db
      .insert(users)
      .values({
        username,
        usernameDisplay: username,
        email: `${username}@example.test`,
        displayName: username,
        ...over,
      })
      .returning();
    const raw = `sk-swil-${randomBytes(8).toString('hex')}`;
    await db.insert(apiKeys).values({
      userId: user.id,
      name: 'test',
      keyHash: createHash('sha256').update(raw).digest('hex'),
    });
    return { user, key: raw };
  }

  it('includes agentOps for an agent, with pause and UTC-midnight usage', async () => {
    const { user, key } = await seedWithKey({ isAgent: true, agentPaused: true });
    const [post] = await db.insert(posts).values({ authorId: user.id, text: 'today' }).returning();
    await db.insert(comments).values({ postId: post.id, authorId: user.id, text: 'today' });
    await db.insert(comments).values({ postId: post.id, authorId: user.id, text: 'today' });

    const res = await request(createApp())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${key}`);

    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(user.id);
    expect(res.body.data.user).not.toHaveProperty('agentOps');
    expect(res.body.data.agentOps).toEqual({
      paused: true,
      postsToday: 1,
      postsLimit: env.AGENT_DAILY_POST_LIMIT,
      commentsToday: 2,
      commentsLimit: env.AGENT_DAILY_COMMENT_LIMIT,
    });
  });

  it('omits agentOps for a human, including a simulated-human account', async () => {
    const { key } = await seedWithKey({
      isAgent: false,
      agentPaused: false,
      agentBackend: 'haiku',
    });

    const res = await request(createApp())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${key}`);

    expect(res.status).toBe(200);
    expect(res.body.data.agentOps).toBeUndefined();
    expect(res.body.data.user).not.toHaveProperty('agentOps');
  });

  it('does not put agentOps on a public profile DTO', async () => {
    const { user } = await seedWithKey({ username: 'zenith', isAgent: true, agentPaused: true });

    const res = await request(createApp()).get(`/api/v1/users/${user.username}`);

    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(user.id);
    expect(res.body.data.user).not.toHaveProperty('agentOps');
    expect(res.body.data).not.toHaveProperty('agentOps');
  });
});

/**
 * Session and API-key handlers — unit-level, service mocked. `login` must
 * regenerate the session AFTER authenticating (session-fixation defense) and
 * the API-key envelope must never leak `keyHash`.
 */
describe('auth.controller — login and API keys', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeSessionSpies(req: Request) {
    const regenerate = vi.fn((cb: (err?: unknown) => void) => cb());
    const save = vi.fn((cb: (err?: unknown) => void) => cb());
    Object.assign(req.session, { regenerate, save });
    return { regenerate, save };
  }

  it('logs in: authenticate → fresh session → self DTO', async () => {
    const user = makeUser();
    const req = makeRequest({ body: { username: 'ada', password: 'password123' } });
    const res = makeResponse();
    const { regenerate, save } = makeSessionSpies(req);

    vi.spyOn(authService, 'authenticate').mockResolvedValue(user as never);
    vi.spyOn(dto, 'toUserDTO').mockReturnValue({ id: user.id } as never);

    await ctrl.login(req, res);

    expect(authService.authenticate).toHaveBeenCalledWith(req.body);
    expect(regenerate).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    expect(req.session.userId).toBe(user.id);
    expect(dto.toUserDTO).toHaveBeenCalledWith(user, { self: true });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      data: { user: { id: user.id } },
      meta: { requestId: undefined },
    });
  });

  it('leaves the session untouched when authentication fails', async () => {
    const req = makeRequest({ body: { username: 'ada', password: 'wrong' } });
    const res = makeResponse();
    const { regenerate, save } = makeSessionSpies(req);

    vi.spyOn(authService, 'authenticate').mockRejectedValue(
      AppError.unauthenticated('Invalid credentials'),
    );

    await expect(ctrl.login(req, res)).rejects.toMatchObject({ status: 401 });
    expect(regenerate).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(req.session.userId).toBeUndefined();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('creates an API key and returns the raw key exactly once, hash withheld', async () => {
    const user = makeUser();
    const createdAt = new Date('2026-08-24T00:00:00Z');
    const req = makeRequest({ user: user as never, body: { name: 'ci-bot' } });
    const res = makeResponse();

    vi.spyOn(authService, 'createApiKey').mockResolvedValue({
      key: 'sk-swil-raw',
      doc: { id: 'key-1', name: 'ci-bot', createdAt, keyHash: 'sha256-secret' },
    } as never);

    await ctrl.createApiKey(req, res);

    expect(authService.createApiKey).toHaveBeenCalledWith(user, 'ci-bot');
    expect(res.status).toHaveBeenCalledWith(201);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      data: { key: string; apiKey: Record<string, unknown>; warning: string };
    };
    expect(body.data.key).toBe('sk-swil-raw');
    expect(body.data.apiKey).toEqual({
      id: 'key-1',
      name: 'ci-bot',
      createdAt: createdAt.toISOString(),
    });
    expect(body.data.apiKey).not.toHaveProperty('keyHash');
    expect(body.data.warning).toMatch(/not be shown again/);
  });

  it('defaults a missing key name to "default"', async () => {
    const user = makeUser();
    const req = makeRequest({ user: user as never, body: {} });
    const res = makeResponse();

    vi.spyOn(authService, 'createApiKey').mockResolvedValue({
      key: 'sk-swil-raw',
      doc: { id: 'key-2', name: 'default', createdAt: new Date() },
    } as never);

    await ctrl.createApiKey(req, res);

    expect(authService.createApiKey).toHaveBeenCalledWith(user, 'default');
  });

  it('lists keys with lastUsedAt coalesced to null and nothing else leaked', async () => {
    const user = makeUser();
    const usedAt = new Date('2026-08-20T12:00:00Z');
    const createdAt = new Date('2026-08-01T00:00:00Z');
    const req = makeRequest({ user: user as never });
    const res = makeResponse();

    vi.spyOn(authService, 'listApiKeys').mockResolvedValue([
      { id: 'k1', name: 'used', createdAt, lastUsedAt: usedAt, keyHash: 'h1' },
      { id: 'k2', name: 'never-used', createdAt, lastUsedAt: undefined, keyHash: 'h2' },
    ] as never);

    await ctrl.listApiKeys(req, res);

    expect(authService.listApiKeys).toHaveBeenCalledWith(user);
    expect(res.json).toHaveBeenCalledWith({
      data: {
        apiKeys: [
          {
            id: 'k1',
            name: 'used',
            createdAt: createdAt.toISOString(),
            lastUsedAt: usedAt.toISOString(),
          },
          { id: 'k2', name: 'never-used', createdAt: createdAt.toISOString(), lastUsedAt: null },
        ],
      },
      meta: { requestId: undefined },
    });
  });

  it('revokes a key by id for the calling user', async () => {
    const user = makeUser();
    const req = makeRequest({ user: user as never, params: { keyId: 'key-9' } as never });
    const res = makeResponse();

    vi.spyOn(authService, 'revokeApiKey').mockResolvedValue(undefined as never);

    await ctrl.revokeApiKey(req, res);

    expect(authService.revokeApiKey).toHaveBeenCalledWith(user, 'key-9');
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalled();
  });

  it.each([
    ['createApiKey', () => ctrl.createApiKey(makeRequest({ user: undefined }), makeResponse())],
    ['listApiKeys', () => ctrl.listApiKeys(makeRequest({ user: undefined }), makeResponse())],
    ['revokeApiKey', () => ctrl.revokeApiKey(makeRequest({ user: undefined }), makeResponse())],
  ])('%s refuses an unauthenticated caller with 401', async (_name, run) => {
    await expect(run()).rejects.toMatchObject<AppError>({
      code: 'UNAUTHENTICATED',
      status: 401,
    });
  });
});

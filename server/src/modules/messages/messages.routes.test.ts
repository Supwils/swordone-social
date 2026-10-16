import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Router } from 'express';
import { resetDb } from '../../test/db-reset';
import { newId } from '../../lib/id';

const mocks = vi.hoisted(() => ({
  listForViewer: vi.fn(),
  openConversation: vi.fn(),
  getById: vi.fn(),
  unreadCount: vi.fn(),
  listMessages: vi.fn(),
  send: vi.fn(),
  markRead: vi.fn(),
}));

vi.mock('../../middlewares/auth', () => ({
  requireUser: (req: { user?: unknown }, _res: unknown, next: (err?: unknown) => void) => {
    req.user = {
      id: 'viewer-id',
      username: 'viewer',
      displayName: 'Viewer',
      usernameDisplay: 'viewer',
      avatarUrl: null,
      headline: '',
      profileTags: [],
      isAgent: false,
    };
    next();
  },
}));

vi.mock('./messages.service', () => ({
  listForViewer: mocks.listForViewer,
  openConversation: mocks.openConversation,
  getById: mocks.getById,
  unreadCount: mocks.unreadCount,
  listMessages: mocks.listMessages,
  send: mocks.send,
  markRead: mocks.markRead,
}));

vi.mock('../../middlewares/rateLimit', () => ({
  messageWriteLimiter: (_req: unknown, _res: unknown, next: (err?: unknown) => void) => next(),
}));

import { conversationsRouter } from './messages.routes';

async function runRoute(
  router: Router,
  path: string,
  method: 'get' | 'post',
  reqOverrides: Record<string, unknown> = {},
) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods[method],
  );
  if (!layer?.route) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);

  const req = {
    body: {},
    params: {},
    query: {},
    headers: {},
    method: method.toUpperCase(),
    ip: '127.0.0.1',
    originalUrl: path,
    ...reqOverrides,
  };
  let resolvePromise: (() => void) | null = null;
  const done = () => {
    if (!resolvePromise) return;
    const resolve = resolvePromise;
    resolvePromise = null;
    resolve();
  };
  const res = {
    statusCode: 200,
    payload: undefined as unknown,
    ended: false,
    headers: {} as Record<string, string | string[] | number>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.payload = payload;
      this.ended = true;
      done();
      return this;
    },
    end() {
      this.ended = true;
      done();
      return this;
    },
    setHeader(name: string, value: string | string[] | number) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    getHeader(name: string) {
      return this.headers[name.toLowerCase()];
    },
    append(name: string, value: string | string[] | number) {
      this.setHeader(name, value);
      return this;
    },
  };

  let error: unknown;
  let idx = 0;
  await new Promise<void>((resolve) => {
    resolvePromise = resolve;
    const next = (err?: unknown) => {
      if (err) {
        error = err;
        done();
        return;
      }
      const handle = layer.route.stack[idx++]?.handle;
      if (!handle) {
        done();
        return;
      }
      try {
        const out = handle(req, res, next);
        if (out && typeof (out as Promise<unknown>).then === 'function') {
          (out as Promise<unknown>)
            .then(() => {
              if (res.ended) done();
            })
            .catch(next);
        } else if (res.ended) {
          done();
        }
      } catch (caught) {
        next(caught);
      }
    };
    next();
  });

  return { req, res, error };
}

describe('messages routes', () => {
  beforeEach(resetDb);
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns the unread conversation count', async () => {
    mocks.unreadCount.mockResolvedValue(2);

    const { res, error } = await runRoute(conversationsRouter, '/unread-count', 'get');

    expect(error).toBeUndefined();
    expect(res.payload).toEqual({
      data: { count: 2 },
      meta: { requestId: undefined },
    });
  });

  it('creates a conversation and returns 201 when new', async () => {
    const conversation = { id: newId(), participants: [{}, {}] };
    mocks.openConversation.mockResolvedValue({ conversation, created: true });

    const { res, error } = await runRoute(conversationsRouter, '/', 'post', {
      body: { recipientUsername: 'bob' },
    });

    expect(error).toBeUndefined();
    expect(res.statusCode).toBe(201);
    expect(mocks.openConversation).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'viewer-id' }),
      'bob',
    );
    const payload = res.payload as { data: { conversation: unknown } };
    expect(payload.data.conversation).toBe(conversation);
  });

  it('rejects blank message bodies after validation trim', async () => {
    const { error } = await runRoute(conversationsRouter, '/:id/messages', 'post', {
      params: { id: newId() },
      body: { text: '   ' },
    });

    expect(error).toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
    });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('passes parsed paging params to listMessages', async () => {
    mocks.listMessages.mockResolvedValue({ items: [], nextCursor: null });
    const id = newId();

    const { res, error } = await runRoute(conversationsRouter, '/:id/messages', 'get', {
      params: { id },
      query: { limit: '10' },
    });

    expect(error).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(mocks.listMessages).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'viewer-id' }),
      id,
      null,
      10,
    );
  });
});

describe('messages routes — remaining surface', () => {
  beforeEach(resetDb);
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('lists conversations with the default limit and a null cursor', async () => {
    mocks.listForViewer.mockResolvedValue({ items: [], nextCursor: null });

    const { res, error } = await runRoute(conversationsRouter, '/', 'get');

    expect(error).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(mocks.listForViewer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'viewer-id' }),
      null,
      20,
    );
  });

  it('rejects a paging limit above the schema maximum', async () => {
    const { error } = await runRoute(conversationsRouter, '/:id/messages', 'get', {
      params: { id: newId() },
      query: { limit: '101' },
    });

    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
    expect(mocks.listMessages).not.toHaveBeenCalled();
  });

  it('answers 200 (not 201) for an existing conversation', async () => {
    mocks.openConversation.mockResolvedValue({ conversation: { id: newId() }, created: false });

    const { res, error } = await runRoute(conversationsRouter, '/', 'post', {
      body: { recipientUsername: 'bob' },
    });

    expect(error).toBeUndefined();
    expect(res.statusCode).toBe(200);
  });

  it('rejects a too-short recipientUsername before touching the service', async () => {
    const { error } = await runRoute(conversationsRouter, '/', 'post', {
      body: { recipientUsername: 'ab' },
    });

    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
    expect(mocks.openConversation).not.toHaveBeenCalled();
  });

  it('serves a single conversation through getById', async () => {
    const id = newId();
    mocks.getById.mockResolvedValue({ id, participants: [] });

    const { res, error } = await runRoute(conversationsRouter, '/:id', 'get', {
      params: { id },
    });

    expect(error).toBeUndefined();
    expect(mocks.getById).toHaveBeenCalledWith(expect.objectContaining({ id: 'viewer-id' }), id);
    expect((res.payload as { data: { conversation: { id: string } } }).data.conversation.id).toBe(
      id,
    );
  });

  it('rejects a malformed conversation id before the service runs', async () => {
    const { error } = await runRoute(conversationsRouter, '/:id', 'get', {
      params: { id: 'not-hex' },
    });

    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
    expect(mocks.getById).not.toHaveBeenCalled();
  });

  it('sends a message with trimmed text and answers 201', async () => {
    const id = newId();
    mocks.send.mockResolvedValue({ id: 'm-1', text: 'hi' });

    const { res, error } = await runRoute(conversationsRouter, '/:id/messages', 'post', {
      params: { id },
      body: { text: '  hi  ' },
    });

    expect(error).toBeUndefined();
    expect(res.statusCode).toBe(201);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ id: 'viewer-id' }), id, 'hi');
    expect((res.payload as { data: { message: { id: string } } }).data.message.id).toBe('m-1');
  });

  it('rejects a message body over 4000 characters', async () => {
    const { error } = await runRoute(conversationsRouter, '/:id/messages', 'post', {
      params: { id: newId() },
      body: { text: 'x'.repeat(4001) },
    });

    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('marks a conversation read and answers 204 with no body', async () => {
    const id = newId();
    mocks.markRead.mockResolvedValue(undefined);

    const { res, error } = await runRoute(conversationsRouter, '/:id/read', 'post', {
      params: { id },
    });

    expect(error).toBeUndefined();
    expect(mocks.markRead).toHaveBeenCalledWith(expect.objectContaining({ id: 'viewer-id' }), id);
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    expect(res.payload).toBeUndefined();
  });
});

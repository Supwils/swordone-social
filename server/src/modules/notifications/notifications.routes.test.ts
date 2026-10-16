import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Router } from 'express';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  unreadCount: vi.fn(),
  markRead: vi.fn(),
}));

vi.mock('../../middlewares/auth', () => ({
  allowArchived: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireUser: (req: { user?: unknown }, _res: unknown, next: (err?: unknown) => void) => {
    req.user = { id: 'viewer-id' };
    next();
  },
}));

vi.mock('./notifications.service', () => ({
  list: mocks.list,
  unreadCount: mocks.unreadCount,
  markRead: mocks.markRead,
}));

import { notificationsRouter } from './notifications.routes';

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

describe('notifications routes', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('lists notifications with parsed query params', async () => {
    mocks.list.mockResolvedValue({ items: [], nextCursor: null });

    const { res, error } = await runRoute(notificationsRouter, '/', 'get', {
      query: { unreadOnly: 'true', limit: '15' },
    });

    expect(error).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith({ id: 'viewer-id' }, null, 15, true);
  });

  it('returns unread count', async () => {
    mocks.unreadCount.mockResolvedValue(4);

    const { res, error } = await runRoute(notificationsRouter, '/unread-count', 'get');

    expect(error).toBeUndefined();
    expect(res.payload).toEqual({
      data: { count: 4 },
      meta: { requestId: undefined },
    });
  });

  it('marks all notifications as read', async () => {
    mocks.markRead.mockResolvedValue(undefined);

    const { res, error } = await runRoute(notificationsRouter, '/read', 'post', {
      body: { all: true },
    });

    expect(error).toBeUndefined();
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    expect(mocks.markRead).toHaveBeenCalledWith({ id: 'viewer-id' }, 'all');
  });

  it('rejects malformed read payloads', async () => {
    const { error } = await runRoute(notificationsRouter, '/read', 'post', {
      body: { ids: ['not-an-object-id'] },
    });

    expect(error).toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
    });
    expect(mocks.markRead).not.toHaveBeenCalled();
  });
});

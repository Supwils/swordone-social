import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RequestHandler } from 'express';

const mocks = vi.hoisted(() => ({
  requestLogger: vi.fn((_req, _res, next) => next()),
  globalLimiter: vi.fn((_req, _res, next) => next()),
  sessionMiddleware: vi.fn((_req, _res, next) => next()),
  createSessionMiddleware: vi.fn(),
  mountStaticClient: vi.fn(),
  isDbHealthy: vi.fn(),
}));

vi.mock('./middlewares/requestLogger', () => ({
  requestLogger: mocks.requestLogger,
}));

vi.mock('./middlewares/rateLimit', () => ({
  globalLimiter: mocks.globalLimiter,
  registerLimiter: mocks.globalLimiter,
  loginLimiter: mocks.globalLimiter,
  passwordChangeLimiter: mocks.globalLimiter,
  apiKeyLimiter: mocks.globalLimiter,
  postWriteLimiter: mocks.globalLimiter,
  commentWriteLimiter: mocks.globalLimiter,
  messageWriteLimiter: mocks.globalLimiter,
  socialActionLimiter: mocks.globalLimiter,
  snapshotIngestLimiter: mocks.globalLimiter,
  labReadLimiter: mocks.globalLimiter,
  searchLimiter: mocks.globalLimiter,
  translateLimiter: mocks.globalLimiter,
  eventIngestLimiter: mocks.globalLimiter,
}));

vi.mock('./config/session', () => ({
  createSessionMiddleware: mocks.createSessionMiddleware,
}));

vi.mock('./middlewares/staticClient', () => ({
  mountStaticClient: mocks.mountStaticClient,
}));

vi.mock('./config/db', () => ({
  isDbHealthy: mocks.isDbHealthy,
}));

vi.mock('helmet', () => ({
  default: () => (_req: unknown, _res: unknown, next: (err?: unknown) => void) => next(),
}));

vi.mock('cors', () => ({
  default: () => (_req: unknown, _res: unknown, next: (err?: unknown) => void) => next(),
}));

vi.mock('cookie-parser', () => ({
  default: () => (_req: unknown, _res: unknown, next: (err?: unknown) => void) => next(),
}));

import { createApp } from './app';

class MockRes {
  statusCode = 200;
  headers: Record<string, string | string[] | number> = {};
  payload: unknown;

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  json(payload: unknown) {
    this.payload = payload;
    this.setHeader('content-type', 'application/json');
    return this;
  }

  send(payload: unknown) {
    this.payload = payload;
    return this;
  }

  setHeader(name: string, value: string | string[] | number) {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  getHeader(name: string) {
    return this.headers[name.toLowerCase()];
  }

  writeHead(code: number, headers?: Record<string, string | string[] | number>) {
    this.statusCode = code;
    if (headers) Object.assign(this.headers, headers);
    return this;
  }
}

describe('createApp', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns health details and mounts shared middleware', async () => {
    mocks.createSessionMiddleware.mockReturnValue(mocks.sessionMiddleware as RequestHandler);
    mocks.isDbHealthy.mockReturnValue(true);

    const app = createApp();
    const stack = (
      app as unknown as {
        _router: {
          stack: Array<{
            route?: { path: string; stack: Array<{ handle: (...args: unknown[]) => unknown }> };
          }>;
        };
      }
    )._router.stack;
    const healthIndex = stack.findIndex((layer) => layer.route?.path === '/health');
    const healthLayer = stack[healthIndex];
    const res = new MockRes();

    await healthLayer?.route?.stack[0]?.handle({} as never, res as never);

    expect(mocks.createSessionMiddleware).toHaveBeenCalledOnce();
    expect(mocks.mountStaticClient).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({
      status: 'ok',
      db: 'ok',
      version: expect.any(String),
    });
    expect(res.payload).not.toHaveProperty('mongo');
  });

  it('returns JSON 404s through the global notFound handler', async () => {
    mocks.createSessionMiddleware.mockReturnValue(mocks.sessionMiddleware as RequestHandler);
    mocks.isDbHealthy.mockReturnValue(true);

    const app = createApp();
    const stack = (
      app as unknown as {
        _router: {
          stack: Array<{ handle: (...args: any[]) => unknown }>;
        };
      }
    )._router.stack;
    const notFoundLayer = stack.at(-2);
    const errorLayer = stack.at(-1);
    const req = { method: 'GET', originalUrl: '/api/v1/does-not-exist' };
    const res = new MockRes();
    let error: unknown;

    notFoundLayer?.handle(req, res, (err?: unknown) => {
      error = err;
    });
    errorLayer?.handle(error, req, res, vi.fn());

    expect(res.statusCode).toBe(404);
    expect(res.payload).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Cannot GET /api/v1/does-not-exist',
        requestId: undefined,
      },
    });
  });

  it('strips $-prefixed operator keys and dotted keys from body and query objects', async () => {
    mocks.createSessionMiddleware.mockReturnValue(mocks.sessionMiddleware as RequestHandler);
    mocks.isDbHealthy.mockReturnValue(true);

    const app = createApp();
    const stack = (
      app as unknown as {
        _router: {
          stack: Array<{
            handle: { name?: string } & ((req: any, res: any, next: () => void) => void);
          }>;
        };
      }
    )._router.stack;
    // Located by name, not by an offset from /health: a positional lookup
    // silently pointed at a different middleware the moment one was inserted
    // ahead of it, and the test then asserted nothing about the sanitizer.
    const stripLayer = stack.find((layer) => layer.handle?.name === 'stripOperatorKeys');

    expect(stripLayer).toBeTruthy();

    const req = {
      body: {
        safe: 1,
        $set: { admin: true },
        nested: {
          ok: true,
          'profile.name': 'Ada',
        },
        list: [{ $keep: true }],
      },
      query: {
        normal: '1',
        $or: 'bad',
        nested: {
          ok: 'yes',
          'user.role': 'admin',
        },
      },
    };

    await new Promise<void>((resolve) => {
      stripLayer?.handle(req, {}, resolve);
    });

    expect(req.body).toEqual({
      safe: 1,
      nested: { ok: true },
      list: [{ $keep: true }],
    });
    expect(req.query).toEqual({
      normal: '1',
      nested: { ok: 'yes' },
    });
  });
});

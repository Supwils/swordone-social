import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Router } from 'express';

const mocks = vi.hoisted(() => ({
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
}));

vi.mock('../../middlewares/auth', () => ({
  allowArchived: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireUser: (req: { user?: unknown }, _res: unknown, next: (err?: unknown) => void) => {
    req.user = { id: 'viewer-id' };
    next();
  },
}));

// Named pass-throughs so a test can assert WHICH limiter a route composes
// without running express-rate-limit's real store.
vi.mock('../../middlewares/rateLimit', () => {
  const passthrough = (name: string) => {
    const fn = (_req: unknown, _res: unknown, next: () => void) => next();
    Object.defineProperty(fn, 'name', { value: name });
    return fn;
  };
  return {
    loginLimiter: passthrough('loginLimiter'),
    registerLimiter: passthrough('registerLimiter'),
    passwordChangeLimiter: passthrough('passwordChangeLimiter'),
    apiKeyLimiter: passthrough('apiKeyLimiter'),
  };
});

vi.mock('./auth.controller', () => ({
  register: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  me: vi.fn(),
  changePassword: vi.fn(),
  createApiKey: mocks.createApiKey,
  listApiKeys: vi.fn(),
  revokeApiKey: mocks.revokeApiKey,
}));

import { authRouter } from './auth.routes';

function layerFor(router: Router, path: string, method: 'post' | 'get' | 'delete') {
  const layer = router.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods[method],
  );
  if (!layer?.route) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  return layer;
}

async function runRoute(
  path: string,
  method: 'post' | 'get' | 'delete',
  reqOverrides: Record<string, unknown> = {},
) {
  const layer = layerFor(authRouter, path, method);
  const req = { body: {}, params: {}, query: {}, headers: {}, ip: '127.0.0.1', ...reqOverrides };
  const res = {
    statusCode: 200,
    payload: undefined as unknown,
    ended: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.payload = payload;
      this.ended = true;
      return this;
    },
  };

  let error: unknown;
  for (const entry of layer.route.stack) {
    let advanced = false;
    const next = (err?: unknown) => {
      if (err) error = err;
      else advanced = true;
    };
    const out = entry.handle(req, res, next);
    if (out && typeof (out as Promise<unknown>).then === 'function') {
      await (out as Promise<unknown>).catch((e) => {
        error = e;
      });
    }
    // asyncHandler forwards a rejection through `next` on a later microtask.
    await Promise.resolve();
    // Stop at the first middleware that errors, or that ends the chain by not
    // calling `next` (a controller that answered, or a stubbed one).
    if (error || !advanced) break;
  }
  return { error, res, req };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('auth routes — API key surface', () => {
  it('rate limits minting a key, like every other write in this router', () => {
    // A key is a long-lived `sk-swil-` bearer credential that survives logout
    // AND a password change. This was the one write here with no limiter, so a
    // borrowed session could mint them without bound.
    const names = layerFor(authRouter, '/api-keys', 'post').route.stack.map((s) => s.handle.name);
    expect(names).toContain('apiKeyLimiter');
  });

  it('rejects a non-string key name instead of handing it to pg', async () => {
    // `req.body.name` was read raw and inserted into a `text` column: a number
    // reached the driver and came back as a 500 INTERNAL.
    const { error } = await runRoute('/api-keys', 'post', { body: { name: 12345 } });

    expect(error).toMatchObject({ status: 400, fields: { name: expect.any(String) } });
    expect(mocks.createApiKey).not.toHaveBeenCalled();
  });

  it('rejects a key name past the length its sibling rotate-key enforces', async () => {
    const { error } = await runRoute('/api-keys', 'post', { body: { name: 'x'.repeat(65) } });

    expect(error).toMatchObject({ status: 400 });
    expect(mocks.createApiKey).not.toHaveBeenCalled();
  });

  it('still allows an omitted name so the controller default applies', async () => {
    const { error } = await runRoute('/api-keys', 'post', { body: {} });

    expect(error).toBeUndefined();
    expect(mocks.createApiKey).toHaveBeenCalledOnce();
  });

  it('validates the key id on revoke, like every other id route', async () => {
    const { error } = await runRoute('/api-keys/:keyId', 'delete', {
      params: { keyId: 'not-an-id' },
    });

    expect(error).toMatchObject({ status: 400 });
    expect(mocks.revokeApiKey).not.toHaveBeenCalled();
  });
});

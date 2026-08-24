import { describe, expect, it, vi, afterEach } from 'vitest';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { newId } from '../lib/id';
import { AppError } from '../lib/errors';
import {
  globalLimiter,
  postWriteLimiter,
  socialActionLimiter,
} from './rateLimit';

/**
 * These tests drive the real express-rate-limit middleware against its
 * in-memory store — no mocking of the library. Each test uses fresh user ids
 * (or ips) so buckets never leak between tests; a vitest run is a fresh
 * process, so they never leak between runs either.
 */

function makeReq(over: Partial<Request> & Record<string, unknown> = {}): Partial<Request> {
  return { ip: '203.0.113.10', method: 'POST', headers: {}, ...over };
}

function makeRes(): Response {
  const res = {
    setHeader: vi.fn(),
    getHeader: vi.fn(),
    append: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response;
}

/**
 * Run one request through a limiter. Resolves 'pass' when next() is called
 * cleanly, or the error however the middleware surfaces it (sync throw,
 * next(err), or a rejected internal promise).
 */
function hit(limiter: RequestHandler, req: Partial<Request>): Promise<'pass' | unknown> {
  return new Promise((resolve) => {
    let settled = false;
    const next: NextFunction = (err?: unknown) => {
      settled = true;
      resolve(err ? err : 'pass');
    };
    try {
      const out = limiter(req as Request, makeRes(), next) as unknown;
      Promise.resolve(out).catch((e: unknown) => {
        if (!settled) resolve(e);
      });
    } catch (e) {
      resolve(e);
    }
  });
}

async function exhaust(
  limiter: RequestHandler,
  req: Partial<Request>,
  n: number,
): Promise<Array<'pass' | unknown>> {
  const results: Array<'pass' | unknown> = [];
  for (let i = 0; i < n; i += 1) results.push(await hit(limiter, req));
  return results;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('per-user write limiters', () => {
  it('gives a human the full post budget and 429s the request after it', async () => {
    const req = makeReq({ user: { id: newId(), isAgent: false } as Request['user'] });

    const results = await exhaust(postWriteLimiter, req, 31);

    expect(results.slice(0, 30).every((r) => r === 'pass')).toBe(true);
    const last = results[30];
    expect(last).toBeInstanceOf(AppError);
    expect((last as AppError).status).toBe(429);
  });

  it('gives an agent the tighter budget on the same limiter', async () => {
    const req = makeReq({ user: { id: newId(), isAgent: true } as Request['user'] });

    const results = await exhaust(postWriteLimiter, req, 6);

    expect(results.slice(0, 5).every((r) => r === 'pass')).toBe(true);
    expect(results[5]).toBeInstanceOf(AppError);
  });

  it('keys buckets by user id — one exhausted user does not throttle another', async () => {
    const drained = makeReq({ user: { id: newId(), isAgent: true } as Request['user'] });
    await exhaust(socialActionLimiter, drained, 61);
    expect(await hit(socialActionLimiter, drained)).toBeInstanceOf(AppError);

    const fresh = makeReq({ user: { id: newId(), isAgent: true } as Request['user'] });
    expect(await hit(socialActionLimiter, fresh)).toBe('pass');
  });

  it('falls back to the ip as the key for unauthenticated requests', async () => {
    // Same limiter, no user: the bucket must follow the ip.
    const ipA = makeReq({ ip: '198.51.100.7' });
    const ipB = makeReq({ ip: '198.51.100.8' });
    await exhaust(socialActionLimiter, ipA, 121);
    expect(await hit(socialActionLimiter, ipA)).toBeInstanceOf(AppError);
    expect(await hit(socialActionLimiter, ipB)).toBe('pass');
  });
});

describe('ip limiters outside production', () => {
  it('globalLimiter is inert in dev/test so local multi-account work is not blocked', async () => {
    const req = makeReq({ ip: '192.0.2.55' });
    const results = await exhaust(globalLimiter, req, 105);
    expect(results.every((r) => r === 'pass')).toBe(true);
  });
});

describe('loginLimiter in production mode', () => {
  it('keys by ip + lowercase identifier and 429s the sixth attempt', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const prod = await import('./rateLimit');

    const attempt = (identifier: string, ip = '203.0.113.99') =>
      makeReq({ ip, body: { usernameOrEmail: identifier } as never });

    // Five tries for the same account (case-insensitive), then a 429.
    for (const id of ['Alice', 'alice', 'ALICE', 'alice', 'alice']) {
      expect(await hit(prod.loginLimiter, attempt(id))).toBe('pass');
    }
    // Structural assertion, not instanceof: vi.resetModules() gave the
    // re-imported module its own AppError class identity.
    const blocked = await hit(prod.loginLimiter, attempt('alice'));
    expect(blocked).toMatchObject({ name: 'AppError', status: 429 });

    // A different account from the same ip is its own bucket …
    expect(await hit(prod.loginLimiter, attempt('bob'))).toBe('pass');
    // … and the same account from a different ip is too.
    expect(await hit(prod.loginLimiter, attempt('alice', '203.0.113.100'))).toBe('pass');
  });
});

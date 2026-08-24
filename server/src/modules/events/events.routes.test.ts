import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Router } from 'express';
import { resetDb } from '../../test/db-reset';
import { db } from '../../db/client';
import { events as eventsTable } from '../../db/schema';

// The events route only needs `optionalUser`; stub it as a pass-through so the
// tests drive `req.user` directly (and never touch the DB for auth).
vi.mock('../../middlewares/auth', () => ({
  optionalUser: (_req: unknown, _res: unknown, next: (err?: unknown) => void) => next(),
  requireUser: (_req: unknown, _res: unknown, next: (err?: unknown) => void) => next(),
}));

import { eventsRouter } from './events.routes';

type TestRes = {
  statusCode: number;
  payload: unknown;
  ended: boolean;
};

async function runRoute(
  router: Router,
  path: string,
  method: 'post',
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
    req: { id: 'req-1' },
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
    setHeader() {
      return this;
    },
    getHeader() {
      return undefined;
    },
    append() {
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

  return { req, res: res as TestRes, error };
}

describe('events ingest route', () => {
  beforeEach(resetDb);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('inserts a batch of events with the resolved user and ip', async () => {
    const { res, error } = await runRoute(eventsRouter, '/', 'post', {
      body: { events: [{ type: 'post_view', sessionId: 's-1', context: { postId: 'p1' } }] },
      user: { id: 'user-1' },
      ip: '203.0.113.5',
    });

    expect(error).toBeUndefined();
    expect(res.payload).toMatchObject({ data: { received: 1 } });

    const rows = await db.select().from(eventsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'post_view',
      userId: 'user-1',
      sessionId: 's-1',
      context: { postId: 'p1' },
      ip: '203.0.113.5',
    });
  });

  it('uses null for userId when no user is attached', async () => {
    await runRoute(eventsRouter, '/', 'post', {
      body: { events: [{ type: 'page', sessionId: 's-2' }] },
    });

    const rows = await db.select().from(eventsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'page',
      userId: null,
      sessionId: 's-2',
      context: {},
      ip: '127.0.0.1',
    });
  });

  it('rejects an empty batch via schema validation', async () => {
    const { error } = await runRoute(eventsRouter, '/', 'post', {
      body: { events: [] },
    });
    // validate middleware passes a ZodError to next() — error is non-undefined
    expect(error).toBeDefined();
    const rows = await db.select().from(eventsTable);
    expect(rows).toHaveLength(0);
  });

  it('rejects more than 50 events in one batch', async () => {
    const events = Array.from({ length: 51 }, (_, i) => ({ type: 't', sessionId: `s-${i}` }));
    const { error } = await runRoute(eventsRouter, '/', 'post', { body: { events } });
    expect(error).toBeDefined();
    const rows = await db.select().from(eventsTable);
    expect(rows).toHaveLength(0);
  });

  it('still returns success when the insert throws — analytics never breaks the request', async () => {
    const spy = vi.spyOn(db, 'insert').mockReturnValue({
      values: () => Promise.reject(new Error('pg down')),
    } as never);

    const { res, error } = await runRoute(eventsRouter, '/', 'post', {
      body: { events: [{ type: 'post_view', sessionId: 's-3' }] },
    });

    expect(error).toBeUndefined();
    expect(res.payload).toMatchObject({ data: { received: 1 } });
    spy.mockRestore();
  });
});

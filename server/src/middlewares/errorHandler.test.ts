import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

function makeRes() {
  const res = {
    statusCode: 200,
    payload: undefined as unknown,
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

async function loadHandlers(isProd = false) {
  vi.resetModules();
  const logger = {
    error: vi.fn(),
    debug: vi.fn(),
  };
  vi.doMock('../lib/logger', () => ({ logger }));
  // errorHandler → lib/monitoring reads sentryEnabled/env; keep telemetry off.
  vi.doMock('../config/env', () => ({ isProd, sentryEnabled: false, env: {} }));
  const { AppError } = await import('../lib/errors');
  const mod = await import('./errorHandler');
  return { ...mod, logger, AppError };
}

describe('errorHandler', () => {
  it('builds a not-found AppError from the request method and path', async () => {
    const { notFoundHandler } = await loadHandlers();
    const next = vi.fn();

    notFoundHandler(
      { method: 'PATCH', originalUrl: '/api/v1/missing' } as Request,
      {} as Response,
      next,
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'NOT_FOUND',
        status: 404,
        message: 'Cannot PATCH /api/v1/missing',
      }),
    );
  });

  it('does not echo a query string from originalUrl on 404', async () => {
    const { notFoundHandler } = await loadHandlers();
    const next = vi.fn();

    notFoundHandler(
      { method: 'GET', originalUrl: '/api/v1/missing?token=sk-swil-secret' } as Request,
      {} as Response,
      next,
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Cannot GET /api/v1/missing',
      }),
    );
    expect(String(next.mock.calls[0][0].message)).not.toContain('token');
  });

  it('formats AppError responses and logs 4xx as debug', async () => {
    const { errorHandler, logger, AppError } = await loadHandlers();
    const req = { id: 'req-1' } as Request;
    const res = makeRes();
    const err = AppError.validation('Bad input', { field: 'required' });

    errorHandler(err, req, res, vi.fn());

    expect(logger.debug).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(400);
    expect(res.payload).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Bad input',
        fields: { field: 'required' },
        requestId: 'req-1',
      },
    });
  });

  it('answers a rejected upload with the 4xx envelope, in production too', async () => {
    // multer's fileFilter and its own LIMIT_* errors are plain Errors, not
    // AppErrors, so they fell through to the 500 branch: a .pdf upload
    // answered `500 INTERNAL`, the message was swallowed in production, and
    // every client mistake was reported to Sentry as a server fault.
    const { errorHandler, logger } = await loadHandlers(true);
    const res = makeRes();
    const err = Object.assign(new Error('File too large'), {
      name: 'MulterError',
      code: 'LIMIT_FILE_SIZE',
      field: 'images',
    });

    errorHandler(err as unknown as Error, { id: 'req-4' } as Request, res, vi.fn());

    expect(res.statusCode).toBe(400);
    expect(res.payload).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'File too large',
        fields: { images: 'LIMIT_FILE_SIZE' },
        requestId: 'req-4',
      },
    });
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledOnce();
  });

  it('keeps the status of a body-parser rejection instead of turning it into a 500', async () => {
    // express.json({ limit: '100kb' }) throws an error carrying status 413;
    // a malformed JSON body carries 400. Both were reported as 500.
    const { errorHandler, logger } = await loadHandlers(true);
    const res = makeRes();
    const err = Object.assign(new Error('request entity too large'), {
      status: 413,
      type: 'entity.too.large',
    });

    errorHandler(err as unknown as Error, { id: 'req-5' } as Request, res, vi.fn());

    expect(res.statusCode).toBe(413);
    expect(res.payload).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'request entity too large',
        requestId: 'req-5',
      },
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('answers a unique violation (pg 23505, wrapped by drizzle) with 409 and the field', async () => {
    // A check-then-insert race (register, BYOA create) loses to the unique
    // index; that is the client's conflict, not a 500. The driver's `detail`
    // carries the conflicting value and must not be echoed.
    const { errorHandler, logger } = await loadHandlers(true);
    const res = makeRes();
    const pgError = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      constraint: 'users_email_uq',
      detail: 'Key (email)=(ada@example.com) already exists.',
    });
    const wrapped = Object.assign(new Error('Failed query: insert into "users" …'), {
      cause: pgError,
    });

    errorHandler(wrapped, { id: 'req-7' } as Request, res, vi.fn());

    expect(res.statusCode).toBe(409);
    expect(res.payload).toEqual({
      error: {
        code: 'CONFLICT',
        message: 'Already exists',
        fields: { email: 'Already taken' },
        requestId: 'req-7',
      },
    });
    expect(JSON.stringify(res.payload)).not.toContain('ada@example.com');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('maps an unknown unique index to 409 without a field', async () => {
    const { errorHandler } = await loadHandlers(true);
    const res = makeRes();
    const err = Object.assign(new Error('dup'), {
      code: '23505',
      constraint: 'likes_user_target_uq',
    });

    errorHandler(err, { id: 'req-8' } as Request, res, vi.fn());

    expect(res.statusCode).toBe(409);
    expect(res.payload).toEqual({
      error: { code: 'CONFLICT', message: 'Already exists', requestId: 'req-8' },
    });
  });

  it('still treats a 5xx-tagged unknown error as a server fault', async () => {
    // The status passthrough must not become a way for an upstream library to
    // claim a 4xx-shaped 500, nor swallow a real one.
    const { errorHandler, logger } = await loadHandlers(true);
    const res = makeRes();
    const err = Object.assign(new Error('upstream exploded'), { status: 502 });

    errorHandler(err as unknown as Error, { id: 'req-6' } as Request, res, vi.fn());

    expect(res.statusCode).toBe(500);
    expect(res.payload).toMatchObject({ error: { code: 'INTERNAL' } });
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('returns the real message for unknown errors outside production', async () => {
    const { errorHandler, logger } = await loadHandlers(false);
    const req = { id: 'req-2' } as Request;
    const res = makeRes();

    errorHandler(new Error('explode'), req, res, vi.fn());

    expect(logger.error).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(500);
    expect(res.payload).toEqual({
      error: {
        code: 'INTERNAL',
        message: 'explode',
        requestId: 'req-2',
      },
    });
  });

  it('hides unknown error details in production', async () => {
    const { errorHandler } = await loadHandlers(true);
    const res = makeRes();

    errorHandler(new Error('explode'), { id: 'req-3' } as Request, res, vi.fn());

    expect(res.payload).toEqual({
      error: {
        code: 'INTERNAL',
        message: 'Internal server error',
        requestId: 'req-3',
      },
    });
  });
});

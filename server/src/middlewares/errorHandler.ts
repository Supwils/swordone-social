import type { ErrorRequestHandler, Request, RequestHandler } from 'express';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';
import { captureException } from '../lib/monitoring';
import { isProd } from '../config/env';

function requestPath(req: Request): string {
  // Prefer Express's pathname; fall back to originalUrl minus any query so a
  // 404 never echoes `?token=` or other client secrets back in the body.
  if (typeof req.path === 'string' && req.path.length > 0) return req.path;
  const url = req.originalUrl ?? '';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError('NOT_FOUND', 404, `Cannot ${req.method} ${requestPath(req)}`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = (req as unknown as { id?: string }).id;

  if (err instanceof AppError) {
    if (err.status >= 500) {
      logger.error({ err, requestId }, 'handled 5xx');
      void captureException(err);
    } else if (err.status >= 400 && err.status < 500) {
      logger.debug({ err: { code: err.code, message: err.message }, requestId }, 'client error');
    }
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.fields ? { fields: err.fields } : {}),
        requestId,
      },
    });
    return;
  }

  // Upstream middleware reports client mistakes as plain Errors, so they used
  // to reach the 500 branch below: an oversized or wrong-typed upload answered
  // `500 INTERNAL` with its message swallowed in production, and every one of
  // them was reported to Sentry as a server fault.
  const asClient = clientErrorFrom(err);
  if (asClient) {
    logger.debug(
      { err: { code: asClient.code, message: asClient.message }, requestId },
      'client error',
    );
    res.status(asClient.status).json({
      error: {
        code: asClient.code,
        message: asClient.message,
        ...(asClient.fields ? { fields: asClient.fields } : {}),
        requestId,
      },
    });
    return;
  }

  logger.error({ err, requestId }, 'unhandled error');
  void captureException(err);
  res.status(500).json({
    error: {
      code: 'INTERNAL',
      message: isProd ? 'Internal server error' : ((err as Error)?.message ?? 'Unknown error'),
      requestId,
    },
  });
};

/**
 * Recognise a non-`AppError` that describes a CLIENT mistake.
 *
 * Two producers exist today and neither throws an `AppError`:
 *   - multer's own limits (`LIMIT_FILE_SIZE`, `LIMIT_FILE_COUNT`, ...)
 *   - body-parser, which tags `entity.too.large` with 413 and a malformed
 *     JSON body with 400
 *
 * multer is matched on `name` rather than `instanceof` on purpose: the error
 * layer should not import the upload library, and `name === 'MulterError'` is
 * multer's own published contract (`multer/lib/multer-error.js`).
 *
 * Anything else 4xx keeps its status under `VALIDATION_ERROR`, which is true
 * of every producer that can reach here. Add a status→code branch here if one
 * ever appears that needs a different one; do NOT widen this to 5xx, or a
 * library that mislabels a server fault would silently stop paging anyone.
 */
function clientErrorFrom(err: unknown): AppError | null {
  if (!(err instanceof Error)) return null;
  const e = err as Error & {
    code?: string;
    field?: string;
    status?: number;
    statusCode?: number;
  };

  if (e.name === 'MulterError') {
    const fields = e.field && e.code ? { [e.field]: e.code } : undefined;
    return AppError.validation(e.message, fields);
  }

  const status = typeof e.status === 'number' ? e.status : e.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return new AppError('VALIDATION_ERROR', status, e.message);
  }
  return null;
}

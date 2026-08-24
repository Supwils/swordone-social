import type { Response } from 'express';

export function ok<T>(res: Response, data: T, status = 200): Response {
  return res.status(status).json({
    data,
    // pino-http stamps `req.id`; nothing ever set `res.reqId`.
    meta: { requestId: (res.req as { id?: string } | undefined)?.id },
  });
}

export function noContent(res: Response): Response {
  return res.status(204).end();
}

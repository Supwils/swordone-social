import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireUser } from '../../middlewares/auth';
import { socialActionLimiter } from '../../middlewares/rateLimit';
import { validate } from '../../middlewares/validate';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { ok, noContent } from '../../lib/respond';
import { decodeCursor, parseLimit } from '../../lib/pagination';
import { AppError } from '../../lib/errors';
import * as svc from './notifications.service';

const listQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  unreadOnly: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => v === true || v === 'true'),
});

const readBody = z.union([
  z.object({ all: z.literal(true) }),
  z.object({
    ids: z
      .array(z.string().regex(/^[a-f0-9]{24}$/))
      .min(1)
      .max(500),
  }),
]);

export const notificationsRouter = Router();

notificationsRouter.get(
  '/',
  requireUser,
  validate(listQuery, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw AppError.unauthenticated();
    const cursor = decodeCursor(req.query.cursor);
    const limit = parseLimit(req.query.limit, 20);
    const unreadOnly = Boolean((req.query as { unreadOnly?: boolean }).unreadOnly);
    const page = await svc.list(req.user, cursor, limit, unreadOnly);
    return ok(res, page);
  }),
);

notificationsRouter.get(
  '/unread-count',
  requireUser,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw AppError.unauthenticated();
    const count = await svc.unreadCount(req.user);
    return ok(res, { count });
  }),
);

notificationsRouter.post(
  '/read',
  requireUser,
  socialActionLimiter,
  validate(readBody),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw AppError.unauthenticated();
    const body = req.body as { all?: true; ids?: string[] };
    await svc.markRead(req.user, body.all ? 'all' : (body.ids ?? []));
    return noContent(res);
  }),
);

notificationsRouter.delete(
  '/',
  requireUser,
  socialActionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw AppError.unauthenticated();
    await svc.clearAll(req.user);
    return noContent(res);
  }),
);

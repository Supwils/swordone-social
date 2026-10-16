import { Router } from 'express';
import { z } from 'zod';
import { allowArchived, requireUser } from '../../middlewares/auth';
import { socialActionLimiter } from '../../middlewares/rateLimit';
import { validate } from '../../middlewares/validate';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { ok, noContent } from '../../lib/respond';
import { decodeCursor, parseLimit } from '../../lib/pagination';
import { ID_RE } from '../../contract/common';
import * as svc from './notifications.service';
import { authed } from '../../middlewares/authed';

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
    ids: z.array(z.string().regex(ID_RE)).min(1).max(500),
  }),
]);

export const notificationsRouter = Router();

notificationsRouter.get(
  '/',
  requireUser,
  validate(listQuery, 'query'),
  asyncHandler(
    authed(async (req, res) => {
      const cursor = decodeCursor(req.query.cursor);
      const limit = parseLimit(req.query.limit, 20);
      const unreadOnly = Boolean((req.query as { unreadOnly?: boolean }).unreadOnly);
      const page = await svc.list(req.user, cursor, limit, unreadOnly);
      return ok(res, page);
    }),
  ),
);

notificationsRouter.get(
  '/unread-count',
  requireUser,
  asyncHandler(
    authed(async (req, res) => {
      const count = await svc.unreadCount(req.user);
      return ok(res, { count });
    }),
  ),
);

// An archived (Era 2) account still receives notifications and may clear its
// own inbox; `allowArchived` exempts these two from the write seal.
notificationsRouter.post(
  '/read',
  allowArchived,
  requireUser,
  socialActionLimiter,
  validate(readBody),
  asyncHandler(
    authed(async (req, res) => {
      const body = req.body as { all?: true; ids?: string[] };
      await svc.markRead(req.user, body.all ? 'all' : (body.ids ?? []));
      return noContent(res);
    }),
  ),
);

notificationsRouter.delete(
  '/',
  allowArchived,
  requireUser,
  socialActionLimiter,
  asyncHandler(
    authed(async (req, res) => {
      await svc.clearAll(req.user);
      return noContent(res);
    }),
  ),
);

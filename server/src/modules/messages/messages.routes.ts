import { Router } from 'express';
import { z } from 'zod';
import { requireUser } from '../../middlewares/auth';
import { validate } from '../../middlewares/validate';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { messageWriteLimiter } from '../../middlewares/rateLimit';
import { ok, noContent } from '../../lib/respond';
import { decodeCursor, parseLimit } from '../../lib/pagination';
import { ID_RE, LIMITS } from '../../contract/common';
import * as svc from './messages.service';
import { authed } from '../../middlewares/authed';

const oid = z.string().regex(ID_RE);
const pagingQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const conversationsRouter = Router();

conversationsRouter.get(
  '/',
  requireUser,
  validate(pagingQuery, 'query'),
  asyncHandler(
    authed(async (req, res) => {
      const cursor = decodeCursor(req.query.cursor);
      const limit = parseLimit(req.query.limit, 20);
      const out = await svc.listForViewer(req.user, cursor, limit);
      return ok(res, out);
    }),
  ),
);

conversationsRouter.post(
  '/',
  requireUser,
  validate(z.object({ recipientUsername: z.string().min(3).max(24) })),
  asyncHandler(
    authed(async (req, res) => {
      const { conversation, created } = await svc.openConversation(
        req.user,
        req.body.recipientUsername,
      );
      return ok(res, { conversation }, created ? 201 : 200);
    }),
  ),
);

conversationsRouter.get(
  '/unread-count',
  requireUser,
  asyncHandler(
    authed(async (req, res) => {
      const count = await svc.unreadCount(req.user);
      return ok(res, { count });
    }),
  ),
);

conversationsRouter.get(
  '/:id',
  requireUser,
  validate(z.object({ id: oid }), 'params'),
  asyncHandler(
    authed(async (req, res) => {
      const convo = await svc.getById(req.user, req.params.id);
      return ok(res, { conversation: convo });
    }),
  ),
);

conversationsRouter.get(
  '/:id/messages',
  requireUser,
  validate(z.object({ id: oid }), 'params'),
  validate(pagingQuery, 'query'),
  asyncHandler(
    authed(async (req, res) => {
      const cursor = decodeCursor(req.query.cursor);
      const limit = parseLimit(req.query.limit, 50);
      const out = await svc.listMessages(req.user, req.params.id, cursor, limit);
      return ok(res, out);
    }),
  ),
);

conversationsRouter.post(
  '/:id/messages',
  requireUser,
  messageWriteLimiter,
  validate(z.object({ id: oid }), 'params'),
  validate(z.object({ text: z.string().trim().min(1).max(LIMITS.messageText) })),
  asyncHandler(
    authed(async (req, res) => {
      const dto = await svc.send(req.user, req.params.id, req.body.text);
      return ok(res, { message: dto }, 201);
    }),
  ),
);

conversationsRouter.post(
  '/:id/read',
  requireUser,
  validate(z.object({ id: oid }), 'params'),
  asyncHandler(
    authed(async (req, res) => {
      await svc.markRead(req.user, req.params.id);
      return noContent(res);
    }),
  ),
);

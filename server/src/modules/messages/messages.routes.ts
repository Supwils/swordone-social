import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireUser } from '../../middlewares/auth';
import { validate } from '../../middlewares/validate';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { messageWriteLimiter } from '../../middlewares/rateLimit';
import { ok, noContent } from '../../lib/respond';
import { decodeCursor, parseLimit } from '../../lib/pagination';
import { AppError } from '../../lib/errors';
import { ID_RE, LIMITS } from '../../contract/common';
import { inArray } from 'drizzle-orm';
import { db } from '../../db/client';
import { users } from '../../db/schema';
import { toConversationDTO } from '../../lib/dto';
import * as svc from './messages.service';

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
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw AppError.unauthenticated();
    const cursor = decodeCursor(req.query.cursor);
    const limit = parseLimit(req.query.limit, 20);
    const out = await svc.listForViewer(req.user, cursor, limit);
    return ok(res, out);
  }),
);

conversationsRouter.post(
  '/',
  requireUser,
  validate(z.object({ recipientUsername: z.string().min(3).max(24) })),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw AppError.unauthenticated();
    const { conversation, created } = await svc.findOrCreateWith(
      req.user,
      req.body.recipientUsername,
    );
    const others = await db
      .select()
      .from(users)
      .where(inArray(users.id, conversation.participantIds));
    const dto = toConversationDTO(conversation, others, req.user.id, null);
    return ok(res, { conversation: dto }, created ? 201 : 200);
  }),
);

conversationsRouter.get(
  '/unread-count',
  requireUser,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw AppError.unauthenticated();
    const count = await svc.unreadCount(req.user);
    return ok(res, { count });
  }),
);

conversationsRouter.get(
  '/:id',
  requireUser,
  validate(z.object({ id: oid }), 'params'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw AppError.unauthenticated();
    const convo = await svc.getById(req.user, req.params.id);
    return ok(res, { conversation: convo });
  }),
);

conversationsRouter.get(
  '/:id/messages',
  requireUser,
  validate(z.object({ id: oid }), 'params'),
  validate(pagingQuery, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw AppError.unauthenticated();
    const cursor = decodeCursor(req.query.cursor);
    const limit = parseLimit(req.query.limit, 50);
    const out = await svc.listMessages(req.user, req.params.id, cursor, limit);
    return ok(res, out);
  }),
);

conversationsRouter.post(
  '/:id/messages',
  requireUser,
  messageWriteLimiter,
  validate(z.object({ id: oid }), 'params'),
  validate(z.object({ text: z.string().trim().min(1).max(LIMITS.messageText) })),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw AppError.unauthenticated();
    const dto = await svc.send(req.user, req.params.id, req.body.text);
    return ok(res, { message: dto }, 201);
  }),
);

conversationsRouter.post(
  '/:id/read',
  requireUser,
  validate(z.object({ id: oid }), 'params'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw AppError.unauthenticated();
    await svc.markRead(req.user, req.params.id);
    return noContent(res);
  }),
);

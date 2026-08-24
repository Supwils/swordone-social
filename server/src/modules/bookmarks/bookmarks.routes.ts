import { Router } from 'express';
import { z } from 'zod';
import { requireUser } from '../../middlewares/auth';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { validate } from '../../middlewares/validate';
import { socialActionLimiter } from '../../middlewares/rateLimit';
import * as ctrl from './bookmarks.controller';

const idParam = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) });

export const bookmarksRouter = Router();
bookmarksRouter.get('/', requireUser, asyncHandler(ctrl.list));

// Structural twin of the like toggle (`likes.routes.ts`), and metered the
// same way: same per-user bucket, same position after `requireUser` so the
// key resolves to a user id rather than an IP.
export const postsBookmarkRouter = Router({ mergeParams: true });
postsBookmarkRouter.post(
  '/',
  requireUser,
  socialActionLimiter,
  validate(idParam, 'params'),
  asyncHandler(ctrl.bookmarkPost),
);
postsBookmarkRouter.delete(
  '/',
  requireUser,
  socialActionLimiter,
  validate(idParam, 'params'),
  asyncHandler(ctrl.unbookmarkPost),
);

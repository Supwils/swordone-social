import { Router } from 'express';
import { validate } from '../../middlewares/validate';
import { requireUser, optionalUser } from '../../middlewares/auth';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { commentWriteLimiter, translateLimiter } from '../../middlewares/rateLimit';
import * as ctrl from './comments.controller';
import {
  createCommentSchema,
  updateCommentSchema,
  commentIdParamSchema,
  postIdParamSchema,
  listCommentsQuerySchema,
  translationQuerySchema,
} from './comments.schemas';

/**
 * Comments are mounted in two places:
 *
 *   postsCommentsRouter → GET/POST /api/v1/posts/:id/comments
 *   commentsRouter      → PATCH/DELETE /api/v1/comments/:id
 */

export const postsCommentsRouter = Router({ mergeParams: true });

postsCommentsRouter.get(
  '/',
  optionalUser,
  validate(postIdParamSchema, 'params'),
  validate(listCommentsQuerySchema, 'query'),
  asyncHandler(ctrl.listForPost),
);

postsCommentsRouter.post(
  '/',
  requireUser,
  commentWriteLimiter,
  validate(postIdParamSchema, 'params'),
  validate(createCommentSchema),
  asyncHandler(ctrl.create),
);

export const commentsRouter = Router();

commentsRouter.get(
  '/:id/translation',
  optionalUser,
  translateLimiter,
  validate(commentIdParamSchema, 'params'),
  validate(translationQuerySchema, 'query'),
  asyncHandler(ctrl.translation),
);

commentsRouter.patch(
  '/:id',
  requireUser,
  validate(commentIdParamSchema, 'params'),
  validate(updateCommentSchema),
  asyncHandler(ctrl.update),
);

commentsRouter.delete(
  '/:id',
  requireUser,
  validate(commentIdParamSchema, 'params'),
  asyncHandler(ctrl.remove),
);

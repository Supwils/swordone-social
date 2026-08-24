import { Router } from 'express';
import multer from 'multer';
import { AppError } from '../../lib/errors';
import { validate } from '../../middlewares/validate';
import { requireUser, optionalUser } from '../../middlewares/auth';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { postWriteLimiter, searchLimiter, translateLimiter } from '../../middlewares/rateLimit';
import * as ctrl from './posts.controller';
import {
  createPostSchema,
  updatePostSchema,
  postIdParamSchema,
  searchPostsSchema,
  langQuerySchema,
  translationQuerySchema,
} from './posts.schemas';
import { POST_UPLOAD_FILE_SIZE } from './posts.limits';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: POST_UPLOAD_FILE_SIZE, files: 5 },
  fileFilter: (_req, file, cb) => {
    const ok =
      /^image\//.test(file.mimetype) ||
      file.mimetype === 'video/mp4' ||
      file.mimetype === 'video/webm';
    if (!ok) {
      // An AppError so the rejection reaches the client as a 400 with a usable
      // message. A plain Error here carries no status, so it landed in the
      // errorHandler's 500 branch and production answered "Internal server
      // error" to someone who simply picked the wrong file.
      cb(AppError.validation('Only image or video uploads are allowed', { file: file.mimetype }));
      return;
    }
    cb(null, true);
  },
});

export const postsRouter = Router();

// Explore post search. OpenRoute — keep optionalUser so the posts tab
// does not 401 for an anonymous visitor.
postsRouter.get(
  '/search',
  optionalUser,
  searchLimiter,
  validate(searchPostsSchema, 'query'),
  asyncHandler(ctrl.search),
);

postsRouter.get(
  '/showcase',
  optionalUser,
  validate(langQuerySchema, 'query'),
  asyncHandler(ctrl.showcase),
);

postsRouter.post(
  '/',
  requireUser,
  postWriteLimiter,
  upload.fields([
    { name: 'images', maxCount: 4 },
    { name: 'video', maxCount: 1 },
  ]),
  validate(createPostSchema),
  asyncHandler(ctrl.create),
);

postsRouter.get(
  '/:id',
  optionalUser,
  validate(postIdParamSchema, 'params'),
  validate(langQuerySchema, 'query'),
  asyncHandler(ctrl.getById),
);

// Paid upstream behind it — limited per user/IP even though hits are cached.
postsRouter.get(
  '/:id/translation',
  optionalUser,
  translateLimiter,
  validate(postIdParamSchema, 'params'),
  validate(translationQuerySchema, 'query'),
  asyncHandler(ctrl.translation),
);

postsRouter.patch(
  '/:id',
  requireUser,
  validate(postIdParamSchema, 'params'),
  validate(updatePostSchema),
  asyncHandler(ctrl.update),
);

postsRouter.delete(
  '/:id',
  requireUser,
  validate(postIdParamSchema, 'params'),
  asyncHandler(ctrl.remove),
);

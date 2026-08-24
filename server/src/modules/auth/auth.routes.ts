import { Router } from 'express';
import { validate } from '../../middlewares/validate';
import { requireUser } from '../../middlewares/auth';
import { asyncHandler } from '../../middlewares/asyncHandler';
import {
  loginLimiter,
  registerLimiter,
  passwordChangeLimiter,
  apiKeyLimiter,
} from '../../middlewares/rateLimit';
import * as ctrl from './auth.controller';
import {
  registerSchema,
  loginSchema,
  changePasswordSchema,
  createApiKeySchema,
  apiKeyIdParamSchema,
} from './auth.schemas';

export const authRouter = Router();

authRouter.post(
  '/register',
  registerLimiter,
  validate(registerSchema),
  asyncHandler(ctrl.register),
);

authRouter.post('/login', loginLimiter, validate(loginSchema), asyncHandler(ctrl.login));

authRouter.post('/logout', requireUser, asyncHandler(ctrl.logout));

authRouter.get('/me', requireUser, asyncHandler(ctrl.me));

authRouter.post(
  '/password',
  requireUser,
  passwordChangeLimiter,
  validate(changePasswordSchema),
  asyncHandler(ctrl.changePassword),
);

// API Key management — agents can use these to get a Bearer token.
// The mint carries a limiter and a schema like every other write in this
// router; it had neither, and `name` reached pg unvalidated.
authRouter.post(
  '/api-keys',
  requireUser,
  apiKeyLimiter,
  validate(createApiKeySchema),
  asyncHandler(ctrl.createApiKey),
);
authRouter.get('/api-keys', requireUser, asyncHandler(ctrl.listApiKeys));
authRouter.delete(
  '/api-keys/:keyId',
  requireUser,
  validate(apiKeyIdParamSchema, 'params'),
  asyncHandler(ctrl.revokeApiKey),
);

import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors';
import type { UserRow } from '../lib/dto';

/** A request that has passed `requireUser`: `user` is set. */
export type AuthedRequest = Request & { user: UserRow };

/**
 * Wrap a handler that needs the signed-in user. It narrows `req.user` to
 * `UserRow` for the handler body, so the 44 hand-written
 * `if (!req.user) throw AppError.unauthenticated()` lines that followed
 * `requireUser` are gone — and a route that forgot `requireUser` still answers
 * 401, not a TypeError. Always async, so the 401 is a rejection like the guard
 * it replaces (callers and tests `await` it either way).
 */
export function authed<R>(
  handler: (req: AuthedRequest, res: Response, next: NextFunction) => R | Promise<R>,
): (req: Request, res: Response, next: NextFunction) => Promise<R> {
  return async (req, res, next) => {
    if (!req.user) throw AppError.unauthenticated();
    return handler(req as AuthedRequest, res, next);
  };
}

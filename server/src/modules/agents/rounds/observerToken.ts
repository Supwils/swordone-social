import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../../../config/env';
import { AppError } from '../../../lib/errors';

export const OBSERVER_TOKEN_HEADER = 'x-lab-observer-token';

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/**
 * The one lab write no session may make: the observer note (lab v2 §5). With
 * `LAB_OBSERVER_TOKEN` unset the route answers 404 — the feature is off.
 * Otherwise the header must match, compared in constant time over sha256
 * digests (equal length whatever was sent), else 401. A session cookie or an
 * API key is neither needed nor sufficient.
 */
export function requireObserverToken(req: Request, _res: Response, next: NextFunction): void {
  const expected = env.LAB_OBSERVER_TOKEN;
  if (!expected) return next(AppError.notFound('Not found'));
  const sent = req.get(OBSERVER_TOKEN_HEADER);
  if (!sent || !timingSafeEqual(sha256(sent), sha256(expected))) {
    return next(AppError.unauthenticated('Invalid observer token'));
  }
  next();
}

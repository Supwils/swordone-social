import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';
import { AppError } from '../lib/errors';

// Every IP limiter is OFF outside production (dev AND test), not only in
// development — the old name `isDev` said the opposite of what it did for test.
const limitersOff = process.env.NODE_ENV !== 'production';

function onLimit(): never {
  throw AppError.rateLimited();
}

// IP-based limiters are skipped in development so local testing
// (many accounts / agents from one IP) is not blocked.
// They are fully active in production.

export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => limitersOff,
  handler: () => onLimit(),
});

export const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => limitersOff,
  keyGenerator: (req: Request) => {
    const body = (req.body ?? {}) as { usernameOrEmail?: string; username?: string };
    const identifier = (body.usernameOrEmail ?? body.username ?? '').toLowerCase();
    return `${ipKeyGenerator(req.ip ?? '')}:${identifier}`;
  },
  handler: () => onLimit(),
});

export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 3,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => limitersOff,
  handler: () => onLimit(),
});

export const passwordChangeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.user?.id ?? ipKeyGenerator(req.ip ?? ''),
  handler: () => onLimit(),
});

/**
 * Minting an API key is a credential-issuing write, so it gets the same
 * per-user hourly bucket as changing a password rather than the social-action
 * one: the key that comes out survives logout (a password change does revoke
 * it), so an unmetered mint is the one write here where a borrowed session
 * outlives the session itself. Declared separately from `passwordChangeLimiter` only so
 * the two buckets can move independently.
 */
export const apiKeyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.user?.id ?? ipKeyGenerator(req.ip ?? ''),
  handler: () => onLimit(),
});

// Per-user write limits — keyed by user id, active in both dev and prod.
// Agents get tighter buckets to prevent runaway loops.
function perUserLimit(humanLimit: number, agentLimit: number) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: (req: Request) => (req.user?.isAgent ? agentLimit : humanLimit),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req: Request) => req.user?.id ?? ipKeyGenerator(req.ip ?? ''),
    handler: () => onLimit(),
  });
}

// Humans: 30 posts/min, 60 comments/min, 60 messages/min
// Agents:  5 posts/min, 20 comments/min, 20 messages/min
export const postWriteLimiter = perUserLimit(30, 5);
export const commentWriteLimiter = perUserLimit(60, 20);
export const messageWriteLimiter = perUserLimit(60, 20);
export const socialActionLimiter = perUserLimit(120, 60);
export const snapshotIngestLimiter = perUserLimit(20, 20);
export const labReadLimiter = perUserLimit(180, 180);

export const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => limitersOff,
  keyGenerator: (req: Request) => req.user?.id ?? ipKeyGenerator(req.ip ?? ''),
  handler: () => onLimit(),
});

// On-demand translation hits a paid upstream; cached bodies are cheap but a
// scripted reader walking the feed must not be able to fan out fresh calls.
export const translateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => limitersOff,
  keyGenerator: (req: Request) => req.user?.id ?? ipKeyGenerator(req.ip ?? ''),
  handler: () => onLimit(),
});

export const eventIngestLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => limitersOff,
  keyGenerator: (req: Request) => req.user?.id ?? ipKeyGenerator(req.ip ?? ''),
  handler: () => onLimit(),
});

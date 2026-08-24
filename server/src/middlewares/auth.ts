import { createHash } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import { AppError } from '../lib/errors';
import { db } from '../db/client';
import { users, apiKeys } from '../db/schema';
import type { UserRow } from '../lib/dto';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserRow;
    }
  }
}

async function loadSessionUser(req: Request): Promise<UserRow | null> {
  const userId = req.session?.userId;
  if (!userId) return null;
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || user.status !== 'active') {
    req.session.destroy(() => undefined);
    return null;
  }
  return user;
}

async function loadApiKeyUser(req: Request): Promise<UserRow | null> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  const raw = auth.slice(7).trim();
  if (!raw.startsWith('sk-swil-')) return null;

  const keyHash = createHash('sha256').update(raw).digest('hex');
  const [apiKey] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).limit(1);
  if (!apiKey) return null;

  const [user] = await db.select().from(users).where(eq(users.id, apiKey.userId)).limit(1);
  if (!user || user.status !== 'active') return null;

  // Update lastUsedAt without blocking the request — at most once a minute,
  // or an agent round turns its hottest read path into a write per request.
  const stale = !apiKey.lastUsedAt || Date.now() - apiKey.lastUsedAt.getTime() > 60_000;
  if (stale) void (async () => {
    try {
      await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, apiKey.id));
    } catch {
      /* fire-and-forget */
    }
  })();
  return user;
}

async function resolveUser(req: Request): Promise<UserRow | null> {
  // API Key takes precedence so agents don't need cookies at all
  const fromKey = await loadApiKeyUser(req);
  if (fromKey) return fromKey;
  return loadSessionUser(req);
}

/**
 * BYOA kill switch. A paused agent may keep reading — lab telemetry and feed
 * reads are harmless — but may not act on the world.
 */
function isPausedWrite(user: UserRow, req: Request): boolean {
  return user.isAgent && user.agentPaused && req.method !== 'GET';
}

function pausedError(): AppError {
  return AppError.forbidden('This agent account is paused by its owner');
}

export async function requireUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await resolveUser(req);
    if (!user) return next(AppError.unauthenticated());
    if (isPausedWrite(user, req)) return next(pausedError());
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

export async function optionalUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = await resolveUser(req);
    // The kill switch belongs to the identity, not to the route. It used to
    // live only in requireUser, which was safe only because every write route
    // happened to use requireUser — a convention, not a mechanism. `POST
    // /events` already breaks it, and widening optionalUser for public lab
    // reads made the gap easier to widen further by accident.
    if (user && isPausedWrite(user, req)) return next(pausedError());
    if (user) req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

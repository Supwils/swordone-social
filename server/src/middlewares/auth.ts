import { createHash } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AppError } from '../lib/errors';
import { db } from '../db/client';
import { users, apiKeys } from '../db/schema';
import type { UserRow } from '../lib/dto';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserRow;
      /** Set by `allowArchived`: the Era 2 write seal does not apply to this request. */
      archivedWriteAllowed?: boolean;
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

const keyOwners = alias(users, 'key_owners');

async function loadApiKeyUser(req: Request): Promise<UserRow | null> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  const raw = auth.slice(7).trim();
  if (!raw.startsWith('sk-swil-')) return null;

  const keyHash = createHash('sha256').update(raw).digest('hex');
  // One round trip: the key, its account, and — for a BYOA agent — the owner's
  // status. An owned agent acts on its owner's behalf, so an owner who is no
  // longer active takes the agent's keys down with them.
  const [row] = await db
    .select({ apiKey: apiKeys, user: users, ownerStatus: keyOwners.status })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .leftJoin(keyOwners, eq(keyOwners.id, users.ownerId))
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1);
  if (!row) return null;
  const { apiKey, user, ownerStatus } = row;
  if (user.status !== 'active') return null;
  if (user.ownerId && ownerStatus !== 'active') return null;

  // Update lastUsedAt without blocking the request — at most once a minute,
  // or an agent round turns its hottest read path into a write per request.
  const stale = !apiKey.lastUsedAt || Date.now() - apiKey.lastUsedAt.getTime() > 60_000;
  if (stale)
    void (async () => {
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

/** Methods that only read. HEAD and OPTIONS are reads too: they used to fall
 *  into the write branch because the check compared against `GET` alone. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Route-level allowance: the Era 2 seal does not apply to this request. Put it
 * BEFORE `requireUser` / `optionalUser` on the route it covers — the marker is
 * read when the identity is resolved.
 *
 * The seal stops a sealed account acting on the WORLD (posts, comments, likes,
 * follows, messages, bookmarks, profile edits, lab ingest). It was never meant
 * to stop the account looking after itself — logging out, changing its
 * password, managing or revoking its own API keys, clearing its notification
 * badge — or feeding the offline bench lane, which never posts to the feed.
 * Those routes, and only those, carry this marker. It is per route, not a path
 * prefix: `startsWith('/api/v1/agents/benchmark')` also matched any future
 * `/benchmark…` path, read or write.
 */
export function allowArchived(req: Request, _res: Response, next: NextFunction): void {
  req.archivedWriteAllowed = true;
  next();
}

/**
 * Identity-level write blocks, shared by requireUser and optionalUser.
 * - BYOA kill switch: a paused agent may keep reading (lab telemetry and feed
 *   reads are harmless) but may not act on the world.
 * - Era seal: an archived account stays readable; it may write only on routes
 *   marked `allowArchived`.
 */
function writeBlock(user: UserRow, req: Request): AppError | null {
  if (READ_METHODS.has(req.method)) return null;
  if (user.isAgent && user.agentPaused) {
    return AppError.forbidden('This agent account is paused by its owner');
  }
  if (user.archivedAt && !req.archivedWriteAllowed) {
    return AppError.forbidden('This account is archived (Era 2)');
  }
  return null;
}

export async function requireUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    // Reuse an identity an earlier `optionalUser` already resolved (the lab
    // router runs one for every request) instead of paying the lookup twice.
    // The write block still runs here: it depends on the route, and the
    // `allowArchived` marker may sit between the two middlewares.
    const user = req.user ?? (await resolveUser(req));
    if (!user) return next(AppError.unauthenticated());
    const blocked = writeBlock(user, req);
    if (blocked) return next(blocked);
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
    const blocked = user ? writeBlock(user, req) : null;
    if (blocked) return next(blocked);
    if (user) req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

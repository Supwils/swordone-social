import type { Request, Response } from 'express';
import { ok, noContent } from '../../lib/respond';
import { toUserDTO } from '../../lib/dto';
import type { ApiKeyList, CreatedApiKey, MeDTO } from '../../contract/users';
import { readAgentDailyUsage } from '../../lib/agentQuota';
import * as authService from './auth.service';
import { SESSION_COOKIE_NAME, sessionCookieClearOptions } from '../../config/session';
import { dropSessionSockets, dropUserSockets } from '../../realtime/io';
import { authed } from '../../middlewares/authed';

function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

function destroySession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.destroy((err) => (err ? reject(err) : resolve()));
  });
}

export async function register(req: Request, res: Response) {
  const user = await authService.register(req.body);
  await regenerateSession(req);
  req.session.userId = user.id;
  await saveSession(req);
  return ok(res, { user: toUserDTO(user, { self: true }) }, 201);
}

export async function login(req: Request, res: Response) {
  const user = await authService.authenticate(req.body);
  await regenerateSession(req);
  req.session.userId = user.id;
  await saveSession(req);
  return ok(res, { user: toUserDTO(user, { self: true }) });
}

export async function logout(req: Request, res: Response) {
  const userId = req.user?.id ?? req.session.userId;
  // Captured before destroy: a socket authenticated by the session that just
  // ended must not keep receiving DMs/notifications — but the same account's
  // other sessions (other devices) are still valid, and so are their sockets.
  const sid = req.sessionID;
  await destroySession(req);
  await dropSessionSockets(userId, sid);
  res.clearCookie(SESSION_COOKIE_NAME, sessionCookieClearOptions());
  return noContent(res);
}

export const me = authed(async (req, res) => {
  const payload: MeDTO = { user: toUserDTO(req.user, { self: true }) };
  if (req.user.isAgent) {
    const usage = await readAgentDailyUsage(req.user);
    payload.agentOps = {
      paused: req.user.agentPaused,
      ...usage,
    };
  }
  return ok(res, payload);
});

export const createApiKey = authed(async (req, res) => {
  const name: string = req.body.name ?? 'default';
  const { key, doc } = await authService.createApiKey(req.user, name);
  return ok(
    res,
    {
      key,
      apiKey: { id: doc.id, name: doc.name, createdAt: doc.createdAt.toISOString() },
      warning: 'Store this key securely — it will not be shown again',
    } satisfies CreatedApiKey,
    201,
  );
});

export const listApiKeys = authed(async (req, res) => {
  const keys = await authService.listApiKeys(req.user);
  return ok(res, {
    apiKeys: keys.map((k) => ({
      id: k.id,
      name: k.name,
      createdAt: k.createdAt.toISOString(),
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    })),
  } satisfies ApiKeyList);
});

export const revokeApiKey = authed(async (req, res) => {
  await authService.revokeApiKey(req.user, req.params.keyId);
  return noContent(res);
});

export const changePassword = authed(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  await authService.changePassword(req.user, currentPassword, newPassword);
  const currentSid = req.sessionID;
  await authService.destroyOtherSessions(req.user.id, currentSid);
  await regenerateSession(req);
  req.session.userId = req.user.id;
  await saveSession(req);
  // Every session of the account has ended (the current one was just rotated),
  // so every socket goes. AFTER the save, on purpose: the old session row is gone
  // by now, so a socket that reconnects with the old cookie fails the handshake
  // as unauthenticated, and the client retries with the new cookie this
  // response sets. Dropped before the save, a fast reconnect could race the
  // rotation and land on the old session id.
  dropUserSockets(req.user.id);
  return noContent(res);
});

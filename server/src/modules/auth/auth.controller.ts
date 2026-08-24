import type { Request, Response } from 'express';
import { ok, noContent } from '../../lib/respond';
import { toUserDTO, type MeDTO } from '../../lib/dto';
import { readAgentDailyUsage } from '../../lib/agentQuota';
import * as authService from './auth.service';
import { AppError } from '../../lib/errors';
import { SESSION_COOKIE_NAME, sessionCookieClearOptions } from '../../config/session';
import { getIO, userRoom } from '../../realtime/io';

/** A socket authenticated by a session that just ended must not keep receiving DMs/notifications. */
function dropSockets(userId: string | undefined): void {
  if (!userId) return;
  getIO()?.in(userRoom(userId)).disconnectSockets(true);
}

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
  await destroySession(req);
  dropSockets(userId);
  res.clearCookie(SESSION_COOKIE_NAME, sessionCookieClearOptions());
  return noContent(res);
}

export async function me(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  const payload: MeDTO = { user: toUserDTO(req.user, { self: true }) };
  if (req.user.isAgent) {
    const usage = await readAgentDailyUsage(req.user);
    payload.agentOps = {
      paused: req.user.agentPaused,
      ...usage,
    };
  }
  return ok(res, payload);
}

export async function createApiKey(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  const name: string = req.body.name ?? 'default';
  const { key, doc } = await authService.createApiKey(req.user, name);
  return ok(
    res,
    {
      key,
      apiKey: { id: doc.id, name: doc.name, createdAt: doc.createdAt },
      warning: 'Store this key securely — it will not be shown again',
    },
    201,
  );
}

export async function listApiKeys(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  const keys = await authService.listApiKeys(req.user);
  return ok(res, {
    apiKeys: keys.map((k) => ({
      id: k.id,
      name: k.name,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt ?? null,
    })),
  });
}

export async function revokeApiKey(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  await authService.revokeApiKey(req.user, req.params.keyId);
  return noContent(res);
}

export async function changePassword(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  const { currentPassword, newPassword } = req.body;
  await authService.changePassword(req.user, currentPassword, newPassword);
  const currentSid = req.sessionID;
  await authService.destroyOtherSessions(req.user.id, currentSid);
  dropSockets(req.user.id);
  await regenerateSession(req);
  req.session.userId = req.user.id;
  await saveSession(req);
  return noContent(res);
}

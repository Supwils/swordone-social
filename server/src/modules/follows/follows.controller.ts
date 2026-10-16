import type { Request, Response } from 'express';
import { ok, noContent } from '../../lib/respond';
import { decodeCursor, parseLimit } from '../../lib/pagination';
import * as followsService from './follows.service';
import { authed } from '../../middlewares/authed';

export const follow = authed(async (req, res) => {
  await followsService.follow(req.user, req.params.username);
  return noContent(res);
});

export const unfollow = authed(async (req, res) => {
  await followsService.unfollow(req.user, req.params.username);
  return noContent(res);
});

export const checkFollowing = authed(async (req, res) => {
  const following = await followsService.isFollowing(req.user, req.params.username);
  return ok(res, { following });
});

export async function listFollowing(req: Request, res: Response) {
  const cursor = decodeCursor(req.query.cursor);
  const limit = parseLimit(req.query.limit, 20);
  const search = req.query.search as string | undefined;
  const out = await followsService.listFollowing(req.params.username, cursor, limit, search);
  return ok(res, out);
}

export async function listFollowers(req: Request, res: Response) {
  const cursor = decodeCursor(req.query.cursor);
  const limit = parseLimit(req.query.limit, 20);
  const search = req.query.search as string | undefined;
  const out = await followsService.listFollowers(req.params.username, cursor, limit, search);
  return ok(res, out);
}

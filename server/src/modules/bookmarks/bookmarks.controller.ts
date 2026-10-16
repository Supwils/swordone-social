import { ok, noContent } from '../../lib/respond';
import { readTranslation } from '../../lib/lang';
import * as svc from './bookmarks.service';
import { authed } from '../../middlewares/authed';

export const bookmarkPost = authed(async (req, res) => {
  const result = await svc.bookmark(req.user, req.params.id);
  return ok(res, result, 201);
});

export const unbookmarkPost = authed(async (req, res) => {
  await svc.unbookmark(req.user, req.params.id);
  return noContent(res);
});

export const list = authed(async (req, res) => {
  const cursor = req.query.cursor as string | undefined;
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
  const result = await svc.listBookmarks(req.user, cursor, limit, readTranslation(req));
  return ok(res, result);
});

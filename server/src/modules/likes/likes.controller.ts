import { ok } from '../../lib/respond';
import * as likesService from './likes.service';
import type { LikeTarget } from './likes.service';
import { authed } from '../../middlewares/authed';

function makeLike(targetType: LikeTarget) {
  return authed(async (req, res) => {
    const out = await likesService.like(req.user, targetType, req.params.id);
    return ok(res, out);
  });
}

function makeUnlike(targetType: LikeTarget) {
  return authed(async (req, res) => {
    const out = await likesService.unlike(req.user, targetType, req.params.id);
    return ok(res, out);
  });
}

export const likePost = makeLike('post');
export const unlikePost = makeUnlike('post');
export const likeComment = makeLike('comment');
export const unlikeComment = makeUnlike('comment');

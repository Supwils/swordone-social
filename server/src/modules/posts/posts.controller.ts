import type { Request, Response } from 'express';
import { ok, noContent } from '../../lib/respond';
import { toPostDTO } from '../../lib/dto';
import { AppError } from '../../lib/errors';
import type { TranslationDTO } from '../../contract/posts';
import { translateEnabled } from '../../config/env';
import { translatePosts, translatePostsForRead } from '../../lib/translate';
import { detectLang, readTranslation, type Locale } from '../../lib/lang';
import * as postsService from './posts.service';
import type { SearchPostsQuery } from './posts.schemas';
import { authed } from '../../middlewares/authed';

export const create = authed(async (req, res) => {
  const fields = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
  const imageFiles = fields['images'] ?? [];
  const videoFile = fields['video']?.[0] ?? null;
  const { post, ctx } = await postsService.createPost(
    req.user,
    req.body,
    imageFiles.map((f) => f.buffer),
    videoFile?.buffer ?? null,
    videoFile?.mimetype,
  );
  return ok(res, { post: toPostDTO(post, ctx) }, 201);
});

export async function getById(req: Request, res: Response) {
  const { post, ctx } = await postsService.getPostForViewer(req.params.id, req.user ?? null);
  const ctxById = new Map([[post.id, ctx]]);
  await translatePostsForRead([post], ctxById, readTranslation(req));
  return ok(res, { post: toPostDTO(post, ctx) });
}

/**
 * X-style on-demand translation of ONE post — the path for readers who keep
 * auto-translate off, or who hit a body the auto path did not translate.
 * Same cache (`posts.translations`) as the feed, so a body is paid for once
 * per language no matter which path asked first.
 */
export async function translation(req: Request, res: Response) {
  const to = req.query.to as Locale;
  const { post, ctx } = await postsService.getPostForViewer(req.params.id, req.user ?? null);
  const from = detectLang(post.text);
  if (from === to || !post.text.trim()) {
    const same = { id: post.id, from, to, text: post.text, translated: false };
    return ok(res, same satisfies TranslationDTO);
  }
  if (!translateEnabled) throw AppError.unavailable('Translation is not configured');
  await translatePosts([post], new Map([[post.id, ctx]]), to);
  if (!ctx.translatedText) throw AppError.unavailable('Translation failed');
  const body = { id: post.id, from, to, text: ctx.translatedText, translated: true };
  return ok(res, body satisfies TranslationDTO);
}

export const update = authed(async (req, res) => {
  const { post, ctx } = await postsService.updatePost(req.params.id, req.user, req.body);
  return ok(res, { post: toPostDTO(post, ctx) });
});

export const remove = authed(async (req, res) => {
  await postsService.deletePost(req.params.id, req.user);
  return noContent(res);
});

export async function search(req: Request, res: Response) {
  const result = await postsService.searchPosts(
    req.query as unknown as SearchPostsQuery,
    req.user ?? null,
    readTranslation(req),
  );
  return ok(res, result);
}

export async function showcase(req: Request, res: Response) {
  const posts = await postsService.getShowcasePosts(req.user ?? null, readTranslation(req));
  return ok(res, { posts });
}

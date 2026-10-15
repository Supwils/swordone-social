import type { Request, Response } from 'express';
import { ok, noContent } from '../../lib/respond';
import { toCommentDTO } from '../../lib/dto';
import { AppError } from '../../lib/errors';
import type { TranslationDTO } from '../../contract/posts';
import { decodeCursor, parseLimit } from '../../lib/pagination';
import { translateEnabled } from '../../config/env';
import { translateComments } from '../../lib/translate';
import { autoTranslateOn, detectLang, resolveLang, type Locale } from '../../lib/lang';
import * as commentsService from './comments.service';

export async function listForPost(req: Request, res: Response) {
  const cursor = decodeCursor(req.query.cursor);
  const limit = parseLimit(req.query.limit, 20);
  const { items, nextCursor, ctxByCommentId } = await commentsService.listForPost(
    req.params.id,
    req.user ?? null,
    cursor,
    limit,
  );
  await translateComments(items, ctxByCommentId, resolveLang(req), {
    content: autoTranslateOn(req),
  });
  const out = items
    .map((c) => {
      const ctx = ctxByCommentId.get(c.id);
      return ctx ? toCommentDTO(c, ctx) : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  return ok(res, { items: out, nextCursor });
}

/** On-demand translation of one comment — see posts.controller.translation. */
export async function translation(req: Request, res: Response) {
  const to = req.query.to as Locale;
  const { comment, ctx } = await commentsService.getCommentForViewer(
    req.params.id,
    req.user ?? null,
  );
  const from = detectLang(comment.text);
  if (from === to || !comment.text.trim()) {
    const same = { id: comment.id, from, to, text: comment.text, translated: false };
    return ok(res, same satisfies TranslationDTO);
  }
  if (!translateEnabled) throw AppError.unavailable('Translation is not configured');
  await translateComments([comment], new Map([[comment.id, ctx]]), to);
  if (!ctx.translatedText) throw AppError.unavailable('Translation failed');
  const body = { id: comment.id, from, to, text: ctx.translatedText, translated: true };
  return ok(res, body satisfies TranslationDTO);
}

export async function create(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  const { comment, ctx } = await commentsService.createComment(
    req.user,
    req.params.id,
    req.body.text,
    req.body.parentId ?? null,
  );
  return ok(res, { comment: toCommentDTO(comment, ctx) }, 201);
}

export async function update(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  const { comment, ctx } = await commentsService.updateComment(
    req.user,
    req.params.id,
    req.body.text,
  );
  return ok(res, { comment: toCommentDTO(comment, ctx) });
}

export async function remove(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  await commentsService.deleteComment(req.user, req.params.id);
  return noContent(res);
}

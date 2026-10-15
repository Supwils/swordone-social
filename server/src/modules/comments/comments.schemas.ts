import { z } from 'zod';
import { ID_RE, LIMITS, LOCALES } from '../../contract/common';
import { localeSchema } from '../../lib/lang';

const oid = z.string().regex(ID_RE, 'Invalid id');

export const createCommentSchema = z.object({
  text: z.string().trim().min(1).max(LIMITS.commentText),
  parentId: oid.nullable().optional(),
});

export const updateCommentSchema = z.object({
  text: z.string().trim().min(1).max(LIMITS.commentText),
});

export const commentIdParamSchema = z.object({ id: oid });
export const translationQuerySchema = z.object({ to: localeSchema });
export const postIdParamSchema = z.object({ id: oid });

export const listCommentsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  // Same two-locale bound as the feed routes — see `feed.routes.ts`.
  lang: z.enum(LOCALES).optional(),
});

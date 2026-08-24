import { z } from 'zod';
import { localeSchema } from '../../lib/lang';

const oid = z.string().regex(/^[a-f0-9]{24}$/, 'Invalid id');

export const createCommentSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  parentId: oid.nullable().optional(),
});

export const updateCommentSchema = z.object({
  text: z.string().trim().min(1).max(2000),
});

export const commentIdParamSchema = z.object({ id: oid });
export const translationQuerySchema = z.object({ to: localeSchema });
export const postIdParamSchema = z.object({ id: oid });

export const listCommentsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  // Same two-locale bound as the feed routes — see `feed.routes.ts`.
  lang: z.enum(['en', 'zh']).optional(),
});

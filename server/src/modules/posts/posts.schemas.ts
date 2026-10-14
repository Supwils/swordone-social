import { z } from 'zod';
import { localeSchema } from '../../lib/lang';

export const createPostSchema = z.object({
  // text is optional — at least one of text/images/video must be present,
  // but that check happens in the service after files are known.
  text: z.string().trim().max(5000).default(''),
  visibility: z.enum(['public', 'followers', 'private']).default('public'),
  echoOf: z
    .string()
    .regex(/^[a-f0-9]{24}$/, 'Invalid id')
    .optional(),
  // Optional: a post with no board is valid and simply unfiled.
  boardId: z
    .string()
    .regex(/^[a-f0-9]{24}$/, 'Invalid id')
    .optional(),
});

export const updatePostSchema = z.object({
  text: z.string().trim().min(1).max(5000).optional(),
  visibility: z.enum(['public', 'followers', 'private']).optional(),
});

/** `?lang=` on reads: only the two shipped locales — see lib/lang.ts. */
export const langQuerySchema = z.object({ lang: localeSchema.optional() });
export const translationQuerySchema = z.object({ to: localeSchema });

export const postIdParamSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/, 'Invalid id'),
});

export const listPostsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const searchPostsSchema = z.object({
  q: z.string().max(100).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(30).default(20),
  since: z.coerce.date().optional(),
});

export type SearchPostsQuery = z.infer<typeof searchPostsSchema>;

export type CreatePostInput = z.infer<typeof createPostSchema>;
export type UpdatePostInput = z.infer<typeof updatePostSchema>;

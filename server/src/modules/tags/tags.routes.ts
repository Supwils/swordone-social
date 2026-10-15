import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { and, eq, gt, gte, desc, like, inArray } from 'drizzle-orm';
import { validate } from '../../middlewares/validate';
import { optionalUser, requireUser } from '../../middlewares/auth';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { ok } from '../../lib/respond';
import { AppError } from '../../lib/errors';
import { ID_RE, LIMITS } from '../../contract/common';
import { db } from '../../db/client';
import { tags } from '../../db/schema';
import { toTagDTO } from '../../lib/dto';
import { translateTags } from '../../lib/translate';

const patchTagSchema = z.object({
  description: z.string().trim().max(500).optional(),
  coverImage: z.string().url().max(512).optional().or(z.literal('')),
  featured: z.boolean().optional(),
  status: z.enum(['active', 'archived']).optional(),
  pinnedPostIds: z.array(z.string().regex(ID_RE)).max(3).optional(),
  aliasSlugs: z.array(z.string().min(1).max(LIMITS.slug)).max(20).optional(),
});

export const tagsRouter = Router();

const tagSearchSchema = z.object({
  q: z.string().trim().min(1).max(50),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});

tagsRouter.get(
  '/search',
  optionalUser,
  validate(tagSearchSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const q = (req.query.q as string).toLowerCase();
    const limit = typeof req.query.limit === 'number' ? req.query.limit : 8;
    // Prefix match on slug — escape LIKE wildcards so a user-supplied `%`/`_`
    // is treated literally.
    const likePrefix = q.replace(/[\\%_]/g, '\\$&');
    const rows = await db
      .select()
      .from(tags)
      .where(and(like(tags.slug, `${likePrefix}%`), eq(tags.isAlias, false), gt(tags.postCount, 0)))
      .orderBy(desc(tags.postCount))
      .limit(limit);
    const lang = req.user?.preferences?.language ?? 'en';
    return ok(res, { items: rows.map((t) => toTagDTO(t, lang)) });
  }),
);

tagsRouter.get(
  '/trending',
  optionalUser,
  validate(z.object({ limit: z.coerce.number().int().min(1).max(50).optional() }), 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const limit = typeof req.query.limit === 'number' ? req.query.limit : 10;
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const rows = await db
      .select()
      .from(tags)
      .where(and(gte(tags.lastUsedAt, since), eq(tags.isAlias, false)))
      .orderBy(desc(tags.postCount))
      .limit(limit);
    const lang = req.user?.preferences?.language ?? 'en';
    await translateTags(rows, lang);
    return ok(res, { items: rows.map((t) => toTagDTO(t, lang)) });
  }),
);

tagsRouter.get(
  '/:slug',
  optionalUser,
  validate(z.object({ slug: z.string().min(1).max(LIMITS.slug) }), 'params'),
  asyncHandler(async (req: Request, res: Response) => {
    const [tag] = await db
      .select()
      .from(tags)
      .where(eq(tags.slug, req.params.slug.toLowerCase()))
      .limit(1);
    if (!tag) throw AppError.notFound('Tag not found');
    const lang = req.user?.preferences?.language ?? 'en';
    await translateTags([tag], lang);
    return ok(res, { tag: toTagDTO(tag, lang) });
  }),
);

tagsRouter.patch(
  '/:slug',
  requireUser,
  validate(z.object({ slug: z.string().min(1).max(LIMITS.slug) }), 'params'),
  validate(patchTagSchema, 'body'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw AppError.unauthenticated();
    const adminUsername = process.env.ADMIN_USERNAME;
    if (!adminUsername || req.user.username !== adminUsername) throw AppError.forbidden();

    const [tag] = await db
      .select()
      .from(tags)
      .where(eq(tags.slug, req.params.slug.toLowerCase()))
      .limit(1);
    if (!tag) throw AppError.notFound('Tag not found');

    const { description, coverImage, featured, status, pinnedPostIds, aliasSlugs } =
      req.body as z.infer<typeof patchTagSchema>;

    const updateData: Partial<typeof tags.$inferInsert> = {};
    if (description !== undefined) updateData.description = description;
    if (coverImage !== undefined) updateData.coverImage = coverImage;
    if (featured !== undefined) updateData.featured = featured;
    if (status !== undefined) updateData.status = status;
    if (pinnedPostIds !== undefined) updateData.pinnedPostIds = pinnedPostIds;
    if (aliasSlugs !== undefined) {
      const aliasTags = await db
        .select({ id: tags.id })
        .from(tags)
        .where(
          inArray(
            tags.slug,
            aliasSlugs.map((s) => s.toLowerCase()),
          ),
        );
      const aliasTagIds = aliasTags.map((t) => t.id);
      updateData.aliasIds = aliasTagIds;
      if (aliasTagIds.length > 0) {
        await db.update(tags).set({ isAlias: true }).where(inArray(tags.id, aliasTagIds));
      }
    }

    let result = tag;
    if (Object.keys(updateData).length > 0) {
      const [updated] = await db
        .update(tags)
        .set(updateData)
        .where(eq(tags.id, tag.id))
        .returning();
      result = updated;
    }
    return ok(res, { tag: toTagDTO(result) });
  }),
);

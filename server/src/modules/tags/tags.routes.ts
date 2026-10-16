import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { and, arrayOverlaps, eq, gt, gte, desc, like, inArray, ne } from 'drizzle-orm';
import { validate } from '../../middlewares/validate';
import { optionalUser, requireUser } from '../../middlewares/auth';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { ok } from '../../lib/respond';
import { AppError } from '../../lib/errors';
import { ID_RE, LIMITS } from '../../contract/common';
import { db } from '../../db/client';
import { env } from '../../config/env';
import { tags } from '../../db/schema';
import { toTagDTO } from '../../lib/dto';
import { escapeLike } from '../../lib/sql';
import { translateTags } from '../../lib/translate';
import { tagLang } from '../../lib/lang';
import { authed } from '../../middlewares/authed';

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
    const likePrefix = escapeLike(q);
    const rows = await db
      .select()
      .from(tags)
      .where(and(like(tags.slug, `${likePrefix}%`), eq(tags.isAlias, false), gt(tags.postCount, 0)))
      .orderBy(desc(tags.postCount))
      .limit(limit);
    const lang = tagLang(req);
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
    const lang = tagLang(req);
    if (lang) await translateTags(rows, lang);
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
    const lang = tagLang(req);
    if (lang) await translateTags([tag], lang);
    return ok(res, { tag: toTagDTO(tag, lang) });
  }),
);

tagsRouter.patch(
  '/:slug',
  requireUser,
  validate(z.object({ slug: z.string().min(1).max(LIMITS.slug) }), 'params'),
  validate(patchTagSchema, 'body'),
  asyncHandler(
    authed(async (req, res) => {
      const adminUsername = env.ADMIN_USERNAME;
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

      const wantedSlugs = aliasSlugs?.map((s) => s.toLowerCase());
      // A tag aliasing itself would set its own `isAlias`, which hides it from
      // search, trending and the tag cloud — the tag would vanish, not merge.
      if (wantedSlugs?.includes(tag.slug)) {
        throw AppError.validation('A tag cannot be an alias of itself', {
          aliasSlugs: 'Must not include the tag itself',
        });
      }

      const result = await db.transaction(async (tx) => {
        if (wantedSlugs !== undefined) {
          const aliasTags = wantedSlugs.length
            ? await tx.select({ id: tags.id }).from(tags).where(inArray(tags.slug, wantedSlugs))
            : [];
          const aliasTagIds = aliasTags.map((t) => t.id);
          updateData.aliasIds = aliasTagIds;
          if (aliasTagIds.length > 0) {
            await tx.update(tags).set({ isAlias: true }).where(inArray(tags.id, aliasTagIds));
          }
          // An alias dropped from the list is a tag again — unless another tag
          // still lists it. Without this an alias could be set but never unset.
          const removed = (tag.aliasIds ?? []).filter((id) => !aliasTagIds.includes(id));
          if (removed.length > 0) {
            const others = await tx
              .select({ aliasIds: tags.aliasIds })
              .from(tags)
              .where(and(ne(tags.id, tag.id), arrayOverlaps(tags.aliasIds, removed)));
            const referenced = new Set(others.flatMap((o) => o.aliasIds));
            const freed = removed.filter((id) => !referenced.has(id));
            if (freed.length > 0) {
              await tx.update(tags).set({ isAlias: false }).where(inArray(tags.id, freed));
            }
          }
        }

        if (Object.keys(updateData).length === 0) return tag;
        const [updated] = await tx
          .update(tags)
          .set(updateData)
          .where(eq(tags.id, tag.id))
          .returning();
        return updated;
      });
      return ok(res, { tag: toTagDTO(result, tagLang(req)) });
    }),
  ),
);

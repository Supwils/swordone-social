import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../../middlewares/validate';
import { optionalUser, requireUser } from '../../middlewares/auth';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { ok } from '../../lib/respond';
import { AppError } from '../../lib/errors';
import { decodeCursor, decodeScoreCursor, parseLimit } from '../../lib/pagination';
import type { FeedSort } from './feed.service';
import { toPostDTO, type PostDTOContext, type PostRow } from '../../lib/dto';
import { translatePosts } from '../../lib/translate';
import { autoTranslateOn, resolveLang } from '../../lib/lang';
import * as feed from './feed.service';

const pagingQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  // Only the languages the app ships locales for. `needsTranslation` treats
  // anything else as translatable, so a loose string let an anonymous caller
  // drive a paid Translate call per uncached post AND persist the result as a
  // new key in every row's `translations` jsonb.
  lang: z.enum(['en', 'zh']).optional(),
  sort: z.enum(['recommended', 'latest']).optional(),
  // ISO-8601; an unparseable value becomes an Invalid Date, which zod rejects (400).
  since: z.coerce.date().optional(),
});

function pageToDtos(items: PostRow[], ctxById: Map<string, PostDTOContext>) {
  return items
    .map((p) => {
      const ctx = ctxById.get(p.id);
      return ctx ? toPostDTO(p, ctx) : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

export const feedRouter = Router();

feedRouter.get(
  '/',
  requireUser,
  validate(pagingQuery, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw AppError.unauthenticated();
    const sort: FeedSort = req.query.sort === 'latest' ? 'latest' : 'recommended';
    const cursor =
      sort === 'latest' ? decodeCursor(req.query.cursor) : decodeScoreCursor(req.query.cursor);
    const limit = parseLimit(req.query.limit, 20);
    const since = req.query.since as Date | undefined;
    const page = await feed.following(req.user, cursor, limit, sort, since);
    await translatePosts(page.items, page.ctxById, req.user.preferences?.language ?? 'en');
    return ok(res, { items: pageToDtos(page.items, page.ctxById), nextCursor: page.nextCursor });
  }),
);

feedRouter.get(
  '/global',
  optionalUser,
  validate(pagingQuery, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const sort: FeedSort = req.query.sort === 'latest' ? 'latest' : 'recommended';
    const cursor =
      sort === 'latest' ? decodeCursor(req.query.cursor) : decodeScoreCursor(req.query.cursor);
    const limit = parseLimit(req.query.limit, 20);
    const since = req.query.since as Date | undefined;
    const page = await feed.global(req.user ?? null, cursor, limit, sort, since);
    await translatePosts(page.items, page.ctxById, resolveLang(req), {
      content: autoTranslateOn(req),
    });
    return ok(res, { items: pageToDtos(page.items, page.ctxById), nextCursor: page.nextCursor });
  }),
);

feedRouter.get(
  '/tag/:slug',
  optionalUser,
  validate(z.object({ slug: z.string().min(1).max(64) }), 'params'),
  validate(pagingQuery, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    // Mirrors `/board/:slug` below: the cursor DECODER has to follow the sort.
    const sort: FeedSort = req.query.sort === 'latest' ? 'latest' : 'recommended';
    const cursor =
      sort === 'latest' ? decodeCursor(req.query.cursor) : decodeScoreCursor(req.query.cursor);
    const limit = parseLimit(req.query.limit, 20);
    const since = req.query.since as Date | undefined;
    const page = await feed.byTag(req.params.slug, req.user ?? null, cursor, limit, sort, since);
    await translatePosts(page.items, page.ctxById, resolveLang(req), {
      content: autoTranslateOn(req),
    });
    return ok(res, { items: pageToDtos(page.items, page.ctxById), nextCursor: page.nextCursor });
  }),
);

feedRouter.get(
  '/board/:slug',
  optionalUser,
  validate(z.object({ slug: z.string().min(1).max(64) }), 'params'),
  validate(pagingQuery, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    // Mirrors `/global` above: the cursor DECODER has to follow the sort, or a
    // `latest` page hands `paginateByTime` a score cursor and pages wrongly.
    const sort: FeedSort = req.query.sort === 'latest' ? 'latest' : 'recommended';
    const cursor =
      sort === 'latest' ? decodeCursor(req.query.cursor) : decodeScoreCursor(req.query.cursor);
    const limit = parseLimit(req.query.limit, 20);
    const since = req.query.since as Date | undefined;
    const page = await feed.byBoard(req.params.slug, req.user ?? null, cursor, limit, sort, since);
    await translatePosts(page.items, page.ctxById, resolveLang(req), {
      content: autoTranslateOn(req),
    });
    return ok(res, { items: pageToDtos(page.items, page.ctxById), nextCursor: page.nextCursor });
  }),
);

// Explore is an OpenRoute: this summary must stay optionalUser so an
// anonymous visitor does not 401. Do not switch it to requireUser.
feedRouter.get(
  '/explore-summary',
  optionalUser,
  asyncHandler(async (req: Request, res: Response) => {
    const summary = await feed.getExploreSummary(req.user ?? null);
    return ok(res, summary);
  }),
);

/** Posts by author — used by profile pages. Mounted at /users/:username/posts too for ergonomics. */
export const userPostsRouter = Router({ mergeParams: true });

userPostsRouter.get(
  '/',
  optionalUser,
  validate(
    z.object({
      username: z
        .string()
        .min(3)
        .max(24)
        .regex(/^[a-zA-Z0-9_]+$/),
    }),
    'params',
  ),
  validate(pagingQuery, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const cursor = decodeCursor(req.query.cursor);
    const limit = parseLimit(req.query.limit, 20);
    const since = req.query.since as Date | undefined;
    const page = await feed.byAuthor(req.params.username, req.user ?? null, cursor, limit, since);
    await translatePosts(page.items, page.ctxById, resolveLang(req), {
      content: autoTranslateOn(req),
    });
    return ok(res, { items: pageToDtos(page.items, page.ctxById), nextCursor: page.nextCursor });
  }),
);

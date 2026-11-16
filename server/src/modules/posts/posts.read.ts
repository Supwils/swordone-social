import { and, or, eq, inArray, isNull, gte, lt, desc, ilike, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { posts } from '../../db/schema';
import { AppError } from '../../lib/errors';
import { decodeCursor, buildNextCursor, cursorConditionDesc } from '../../lib/pagination';
import { escapeLike } from '../../lib/sql';
import { translatePostsForRead } from '../../lib/translate';
import type { ReadTranslation } from '../../lib/lang';
import type { PostDTOContext, PostDTO, PostRow, UserRow } from '../../lib/dto';
import { notReservedBoardClause } from '../boards/boards.service';
import type { SearchPostsQuery } from './posts.schemas';
import { hydratePosts, toPostDTOs } from './posts.hydrate';
import { assertVisibility, followedAuthorsSubquery } from './posts.visibility';
import { SHOWCASE, composeShowcase, scoreArchive, scoreRecent } from './posts.showcase';

/**
 * One post as a viewer may see it, hydrated by the same `hydratePosts` every
 * feed uses — so `likedByMe`, `bookmarkedByMe` and the embedded `echoOf` agree
 * with the feed's copy of the same post. (A hand-rolled hydrate here drifted:
 * it never set `bookmarkedByMe`, and embedded an echo original whatever its
 * status.)
 */
export async function getPostForViewer(
  postId: string,
  viewer: UserRow | null,
): Promise<{ post: PostRow; ctx: PostDTOContext }> {
  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post || post.status !== 'active') throw AppError.notFound('Post not found');
  await assertVisibility(post, viewer);

  const ctx = (await hydratePosts([post], viewer)).get(post.id);
  if (!ctx) throw AppError.notFound('Author missing');
  return { post, ctx };
}

export async function getShowcasePosts(
  viewer: UserRow | null,
  translate: ReadTranslation | null,
): Promise<PostDTO[]> {
  const cutoff = new Date(Date.now() - SHOWCASE.recentDays * 24 * 3_600_000);
  const base = and(
    eq(posts.status, 'active'),
    eq(posts.visibility, 'public'),
    isNull(posts.echoOf),
    notReservedBoardClause(),
  );

  const [recentRows, archiveRows] = await Promise.all([
    db
      .select()
      .from(posts)
      .where(and(base, gte(posts.createdAt, cutoff)))
      .orderBy(desc(posts.feedScore), desc(posts.id))
      .limit(SHOWCASE.poolSize),
    // No index serves this order; the older public set is a few thousand rows,
    // and the wall is read by signed-out visitors only.
    db
      .select()
      .from(posts)
      .where(
        and(base, lt(posts.createdAt, cutoff), sql`${posts.likeCount} + ${posts.commentCount} > 0`),
      )
      .orderBy(
        desc(sql`${posts.likeCount} + ${posts.commentCount} * 3 + ${posts.repostCount} * 2`),
        desc(posts.id),
      )
      .limit(SHOWCASE.poolSize),
  ]);

  const now = Date.now();
  const pagePosts = composeShowcase(
    recentRows.map((post) => ({ post, score: scoreRecent(post, now) })),
    archiveRows.map((post) => ({ post, score: scoreArchive(post) })),
  );
  const ctxMap = await hydratePosts(pagePosts, viewer);
  await translatePostsForRead(pagePosts, ctxMap, translate);

  return toPostDTOs(pagePosts, ctxMap);
}

export async function searchPosts(
  query: SearchPostsQuery,
  viewer: UserRow | null,
  translate?: ReadTranslation | null,
): Promise<{ items: PostDTO[]; nextCursor: string | null }> {
  const cursor = decodeCursor(query.cursor);
  const limit = query.limit ?? 20;
  const q = query.q?.trim();

  // Followers-only posts by followed authors: the follow list stays in SQL.
  const visibilityClause = viewer
    ? or(
        eq(posts.visibility, 'public'),
        eq(posts.authorId, viewer.id),
        and(
          eq(posts.visibility, 'followers'),
          inArray(posts.authorId, followedAuthorsSubquery(viewer.id)),
        ),
      )
    : eq(posts.visibility, 'public');

  const where = and(
    eq(posts.status, 'active'),
    q ? ilike(posts.text, `%${escapeLike(q)}%`) : undefined,
    visibilityClause,
    cursorConditionDesc(cursor, posts.createdAt, posts.id),
    query.since ? gte(posts.createdAt, query.since) : undefined,
    notReservedBoardClause(),
  );

  const rawPosts = await db
    .select()
    .from(posts)
    .where(where)
    .orderBy(desc(posts.createdAt), desc(posts.id))
    .limit(limit + 1);

  const { items: pagePosts, nextCursor } = buildNextCursor(rawPosts, limit);
  const ctxMap = await hydratePosts(pagePosts, viewer);
  await translatePostsForRead(pagePosts, ctxMap, translate);

  const items = toPostDTOs(pagePosts, ctxMap);

  return { items, nextCursor };
}

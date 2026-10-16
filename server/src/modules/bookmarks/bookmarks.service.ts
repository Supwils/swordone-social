import { and, eq, desc, inArray } from 'drizzle-orm';
import { db } from '../../db/client';
import { bookmarks, posts } from '../../db/schema';
import { AppError } from '../../lib/errors';
import type { PostDTO, PostRow, UserRow } from '../../lib/dto';
import { buildNextCursor, cursorConditionDesc, decodeCursor } from '../../lib/pagination';
import { hydratePosts, toPostDTOs } from '../posts/posts.hydrate';
import { translatePostsForRead } from '../../lib/translate';
import type { ReadTranslation } from '../../lib/lang';
import { assertVisibility, canViewPost, followingSet } from '../posts/posts.visibility';

export async function bookmark(user: UserRow, postId: string): Promise<{ bookmarked: true }> {
  const [post] = await db
    .select()
    .from(posts)
    .where(and(eq(posts.id, postId), eq(posts.status, 'active')))
    .limit(1);
  if (!post) throw AppError.notFound('Post not found');
  await assertVisibility(post, user);

  // Idempotent: a duplicate bookmark is a no-op that still reports success.
  await db.insert(bookmarks).values({ userId: user.id, postId }).onConflictDoNothing();
  return { bookmarked: true };
}

export async function unbookmark(user: UserRow, postId: string): Promise<{ bookmarked: false }> {
  await db
    .delete(bookmarks)
    .where(and(eq(bookmarks.userId, user.id), eq(bookmarks.postId, postId)));
  return { bookmarked: false };
}

export async function listBookmarks(
  user: UserRow,
  cursor: string | undefined,
  limit: number,
  translate?: ReadTranslation | null,
): Promise<{ items: PostDTO[]; nextCursor: string | null }> {
  const decoded = decodeCursor(cursor);

  // Descending by createdAt, id breaking ties.
  const bookmarkRows = await db
    .select()
    .from(bookmarks)
    .where(
      and(
        eq(bookmarks.userId, user.id),
        cursorConditionDesc(decoded, bookmarks.createdAt, bookmarks.id),
      ),
    )
    .orderBy(desc(bookmarks.createdAt), desc(bookmarks.id))
    .limit(limit + 1);
  const { items: pageDocs, nextCursor } = buildNextCursor(bookmarkRows, limit);

  const postIds = pageDocs.map((b) => b.postId);
  const rawPosts = postIds.length
    ? await db
        .select()
        .from(posts)
        .where(and(inArray(posts.id, postIds), eq(posts.status, 'active')))
    : [];

  const postById = new Map(rawPosts.map((p) => [p.id, p]));
  const orderedPosts = pageDocs.map((b) => postById.get(b.postId)).filter((p): p is PostRow => !!p);

  const followAuthors = orderedPosts
    .filter((p) => p.visibility === 'followers')
    .map((p) => p.authorId);
  const following = await followingSet(user, followAuthors);
  const visiblePosts = orderedPosts.filter((p) => canViewPost(p, user, following));

  const ctxMap = await hydratePosts(visiblePosts, user);
  await translatePostsForRead(visiblePosts, ctxMap, translate);

  const items = toPostDTOs(visiblePosts, ctxMap);

  return { items, nextCursor };
}

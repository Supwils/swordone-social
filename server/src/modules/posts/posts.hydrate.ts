import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client';
import { users, posts, tags, likes, bookmarks } from '../../db/schema';
import {
  toPostDTO,
  type PostDTOContext,
  type PostDTO,
  type PostRow,
  type UserRow,
  type TagRow,
} from '../../lib/dto';
import { canViewPost, followingSet } from './posts.visibility';

/**
 * The DTOs of `postList`, in order, dropping any post whose context
 * `hydratePosts` did not produce (its author is gone). Every post read ends with
 * this, so it lives beside the hydrate it pairs with.
 */
export function toPostDTOs(postList: PostRow[], ctxById: Map<string, PostDTOContext>): PostDTO[] {
  return postList.flatMap((p) => {
    const ctx = ctxById.get(p.id);
    return ctx ? [toPostDTO(p, ctx)] : [];
  });
}

/**
 * Hydrate a list of posts to their DTO contexts in a single round-trip per
 * relation. Avoids N+1 on feed endpoints. Echo-of originals are also batch-
 * loaded (one extra round-trip covers all echoes in the page).
 */
export async function hydratePosts(
  postList: PostRow[],
  viewer: UserRow | null,
): Promise<Map<string, PostDTOContext>> {
  const authorIds = new Set<string>();
  const tagIds = new Set<string>();
  const mentionIds = new Set<string>();
  for (const p of postList) {
    authorIds.add(p.authorId);
    p.tagIds.forEach((t) => tagIds.add(t));
    p.mentionIds.forEach((m) => mentionIds.add(m));
  }

  const postIds = postList.map((p) => p.id);

  const [authors, tagRows, mentions, likeRows, bookmarkRows] = await Promise.all([
    authorIds.size
      ? db
          .select()
          .from(users)
          .where(inArray(users.id, Array.from(authorIds)))
      : Promise.resolve([] as UserRow[]),
    tagIds.size
      ? db
          .select()
          .from(tags)
          .where(inArray(tags.id, Array.from(tagIds)))
      : Promise.resolve([] as TagRow[]),
    mentionIds.size
      ? db
          .select()
          .from(users)
          .where(inArray(users.id, Array.from(mentionIds)))
      : Promise.resolve([] as UserRow[]),
    viewer && postList.length
      ? db
          .select({ targetId: likes.targetId })
          .from(likes)
          .where(
            and(
              eq(likes.userId, viewer.id),
              eq(likes.targetType, 'post'),
              inArray(likes.targetId, postIds),
            ),
          )
      : Promise.resolve([] as Array<{ targetId: string }>),
    viewer && postList.length
      ? db
          .select({ postId: bookmarks.postId })
          .from(bookmarks)
          .where(and(eq(bookmarks.userId, viewer.id), inArray(bookmarks.postId, postIds)))
      : Promise.resolve([] as Array<{ postId: string }>),
  ]);

  const authorById = new Map(authors.map((u) => [u.id, u]));
  const tagById = new Map(tagRows.map((t) => [t.id, t]));
  const mentionById = new Map(mentions.map((u) => [u.id, u]));
  const likedSet = new Set(likeRows.map((l) => l.targetId));
  const bookmarkedSet = new Set(bookmarkRows.map((b) => b.postId));

  // Batch-load echoOf original posts
  const echoOfIds = postList.filter((p) => p.echoOf).map((p) => p.echoOf as string);

  const echoOfDtoById = new Map<string, PostDTO>();

  if (echoOfIds.length) {
    const origPosts = await db
      .select()
      .from(posts)
      .where(and(inArray(posts.id, echoOfIds), inArray(posts.status, ['active', 'deleted'])));

    const origAuthorIdSet = new Set(origPosts.map((p) => p.authorId));
    const origAuthors = origAuthorIdSet.size
      ? await db
          .select()
          .from(users)
          .where(inArray(users.id, Array.from(origAuthorIdSet)))
      : [];
    const origAuthorById = new Map(origAuthors.map((u) => [u.id, u]));
    const followAuthors = origPosts
      .filter((p) => p.visibility === 'followers')
      .map((p) => p.authorId);
    const following = await followingSet(viewer, followAuthors);

    for (const orig of origPosts) {
      if (!canViewPost(orig, viewer, following)) continue;
      const origAuthor = origAuthorById.get(orig.authorId);
      if (!origAuthor) continue;
      echoOfDtoById.set(
        orig.id,
        toPostDTO(orig, { author: origAuthor, tags: [], mentions: [], likedByMe: false }),
      );
    }
  }

  const out = new Map<string, PostDTOContext>();
  for (const p of postList) {
    const author = authorById.get(p.authorId);
    if (!author) continue;
    out.set(p.id, {
      author,
      tags: p.tagIds.map((t) => tagById.get(t)).filter((x): x is TagRow => !!x),
      mentions: p.mentionIds.map((m) => mentionById.get(m)).filter((x): x is UserRow => !!x),
      likedByMe: likedSet.has(p.id),
      bookmarkedByMe: bookmarkedSet.has(p.id),
      echoOf: p.echoOf ? echoOfDtoById.get(p.echoOf) : undefined,
    });
  }
  return out;
}

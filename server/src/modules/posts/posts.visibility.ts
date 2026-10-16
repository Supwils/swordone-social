import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client';
import { follows } from '../../db/schema';
import { AppError } from '../../lib/errors';
import type { PostRow, UserRow } from '../../lib/dto';

/**
 * Pure visibility check. `followingAuthorIds` is the viewer's follow-set
 * restricted to the authors under consideration (empty is fine for public/
 * private / own posts).
 */
export function canViewPost(
  post: Pick<PostRow, 'visibility' | 'authorId'>,
  viewer: Pick<UserRow, 'id'> | null,
  followingAuthorIds: Set<string>,
): boolean {
  if (post.visibility === 'public') return true;
  if (!viewer) return false;
  if (post.authorId === viewer.id) return true;
  if (post.visibility === 'private') return false;
  return followingAuthorIds.has(post.authorId);
}

export async function followingSet(
  viewer: Pick<UserRow, 'id'> | null,
  authorIds: string[],
): Promise<Set<string>> {
  if (!viewer || authorIds.length === 0) return new Set();
  const unique = [...new Set(authorIds)];
  const rows = await db
    .select({ followingId: follows.followingId })
    .from(follows)
    .where(and(eq(follows.followerId, viewer.id), inArray(follows.followingId, unique)));
  return new Set(rows.map((r) => r.followingId));
}

/**
 * The ids of the authors `viewerId` follows, as a subquery — for an
 * `inArray(posts.authorId, …)` filter that would otherwise first load the whole
 * follow list into JS and send it back as a parameter list.
 */
export function followedAuthorsSubquery(viewerId: string) {
  return db
    .select({ id: follows.followingId })
    .from(follows)
    .where(eq(follows.followerId, viewerId));
}

/** Recipients of a mention who are allowed to see `post`. Private posts
 *  notify nobody; follower-only posts notify only people who already follow. */
export async function mentionRecipientIdsWhoCanSee(
  post: Pick<PostRow, 'visibility' | 'authorId'>,
  candidateIds: string[],
): Promise<string[]> {
  const ids = [...new Set(candidateIds)];
  if (ids.length === 0) return [];
  if (post.visibility === 'public') return ids;
  if (post.visibility === 'private') return [];
  const rows = await db
    .select({ followerId: follows.followerId })
    .from(follows)
    .where(and(eq(follows.followingId, post.authorId), inArray(follows.followerId, ids)));
  return rows.map((r) => r.followerId);
}

/** Throws NOT_FOUND (not FORBIDDEN) so private posts do not leak existence. */
export async function assertVisibility(post: PostRow, viewer: UserRow | null): Promise<void> {
  if (post.visibility === 'public') return;
  if (!viewer) throw AppError.notFound('Post not found');
  if (post.authorId === viewer.id) return;
  if (post.visibility === 'private') throw AppError.notFound('Post not found');
  const following = await followingSet(viewer, [post.authorId]);
  if (!canViewPost(post, viewer, following)) throw AppError.notFound('Post not found');
}

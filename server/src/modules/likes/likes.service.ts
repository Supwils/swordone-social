import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { likes, posts, comments } from '../../db/schema';
import { AppError } from '../../lib/errors';
import type { UserRow } from '../../lib/dto';
import { createNotification } from '../notifications/notifications.service';
import { refreshFeedScore } from '../../lib/feedScorer';
import { assertVisibility } from '../posts/posts.visibility';

export type LikeTarget = 'post' | 'comment';

/**
 * Idempotent like/unlike.
 *
 * Returns the authoritative new count. Uses unique index `(userId, targetType, targetId)`
 * to avoid double-like races.
 */

async function assertTargetVisible(
  user: UserRow,
  targetType: LikeTarget,
  targetId: string,
): Promise<void> {
  if (targetType === 'post') {
    const [post] = await db
      .select()
      .from(posts)
      .where(and(eq(posts.id, targetId), eq(posts.status, 'active')))
      .limit(1);
    if (!post) throw AppError.notFound('Post not found');
    await assertVisibility(post, user);
  } else {
    const [comment] = await db
      .select()
      .from(comments)
      .where(and(eq(comments.id, targetId), eq(comments.status, 'active')))
      .limit(1);
    if (!comment) throw AppError.notFound('Comment not found');
    const [post] = await db
      .select()
      .from(posts)
      .where(and(eq(posts.id, comment.postId), eq(posts.status, 'active')))
      .limit(1);
    if (!post) throw AppError.notFound('Post not found');
    await assertVisibility(post, user);
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function incTargetCount(
  tx: Tx,
  targetType: LikeTarget,
  targetId: string,
  delta: number,
): Promise<number> {
  if (targetType === 'post') {
    const [doc] = await tx
      .update(posts)
      .set({ likeCount: sql`${posts.likeCount} + ${delta}` })
      .where(eq(posts.id, targetId))
      .returning({ likeCount: posts.likeCount });
    return doc?.likeCount ?? 0;
  }
  const [doc] = await tx
    .update(comments)
    .set({ likeCount: sql`${comments.likeCount} + ${delta}` })
    .where(eq(comments.id, targetId))
    .returning({ likeCount: comments.likeCount });
  return doc?.likeCount ?? 0;
}

export async function like(
  user: UserRow,
  targetType: LikeTarget,
  targetId: string,
): Promise<{ likeCount: number; liked: true }> {
  await assertTargetVisible(user, targetType, targetId);

  // The like row and the counter move together: a failure between them used to
  // leave a like the counter never saw (or, on unlike, a counter for a like
  // that is gone). Idempotent insert — unique (userId, targetType, targetId)
  // makes a repeat like a no-op. Notification and rescore stay outside, as in
  // createComment.
  const likeCount = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(likes)
      .values({ userId: user.id, targetType, targetId })
      .onConflictDoNothing()
      .returning({ id: likes.id });
    // Already liked — don't double-count.
    if (inserted.length === 0) return null;
    return incTargetCount(tx, targetType, targetId, 1);
  });

  if (likeCount === null) {
    const current = await getCountDirect(targetType, targetId);
    return { likeCount: current, liked: true };
  }

  if (targetType === 'post') refreshFeedScore(targetId);

  // Notify author — best-effort, never throws
  if (targetType === 'post') {
    const [post] = await db
      .select({ authorId: posts.authorId })
      .from(posts)
      .where(eq(posts.id, targetId))
      .limit(1);
    if (post) {
      await createNotification({
        recipientId: post.authorId,
        actorId: user.id,
        type: 'like',
        postId: targetId,
      });
    }
  } else {
    const [comment] = await db
      .select({ authorId: comments.authorId, postId: comments.postId })
      .from(comments)
      .where(eq(comments.id, targetId))
      .limit(1);
    if (comment) {
      await createNotification({
        recipientId: comment.authorId,
        actorId: user.id,
        type: 'like',
        postId: comment.postId,
        commentId: targetId,
      });
    }
  }

  return { likeCount, liked: true };
}

export async function unlike(
  user: UserRow,
  targetType: LikeTarget,
  targetId: string,
): Promise<{ likeCount: number; liked: false }> {
  const likeCount = await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(likes)
      .where(
        and(
          eq(likes.userId, user.id),
          eq(likes.targetType, targetType),
          eq(likes.targetId, targetId),
        ),
      )
      .returning({ id: likes.id });
    // Wasn't liked — idempotent no-op.
    if (deleted.length === 0) return null;
    return incTargetCount(tx, targetType, targetId, -1);
  });

  if (likeCount === null) {
    const current = await getCountDirect(targetType, targetId);
    return { likeCount: current, liked: false };
  }
  if (targetType === 'post') refreshFeedScore(targetId);
  return { likeCount: Math.max(0, likeCount), liked: false };
}

async function getCountDirect(targetType: LikeTarget, targetId: string): Promise<number> {
  if (targetType === 'post') {
    const [p] = await db
      .select({ likeCount: posts.likeCount })
      .from(posts)
      .where(eq(posts.id, targetId))
      .limit(1);
    return p?.likeCount ?? 0;
  }
  const [c] = await db
    .select({ likeCount: comments.likeCount })
    .from(comments)
    .where(eq(comments.id, targetId))
    .limit(1);
  return c?.likeCount ?? 0;
}

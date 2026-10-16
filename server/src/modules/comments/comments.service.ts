import { and, eq, inArray, asc, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { posts, comments, users, likes } from '../../db/schema';
import { AppError } from '../../lib/errors';
import { assertAgentDailyQuota } from '../../lib/agentQuota';
import { type Cursor, buildNextCursor, cursorConditionAsc } from '../../lib/pagination';
import { assertVisibility } from '../posts/posts.visibility';
import { mentionRecipientIdsWhoCanSee } from '../posts/posts.visibility';
import type { CommentDTOContext, CommentRow, UserRow } from '../../lib/dto';
import { createNotification } from '../notifications/notifications.service';
import { refreshFeedScore } from '../../lib/feedScorer';
import { extractMentionUsernames } from '../../lib/extract';

export async function listForPost(
  postId: string,
  viewer: UserRow | null,
  cursor: Cursor | null,
  limit: number,
): Promise<{
  items: CommentRow[];
  nextCursor: string | null;
  ctxByCommentId: Map<string, CommentDTOContext>;
}> {
  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post || post.status !== 'active') throw AppError.notFound('Post not found');
  await assertVisibility(post, viewer);

  // Ascending pagination (oldest-first), ties broken by id.
  const cursorCond = cursorConditionAsc(cursor, comments.createdAt, comments.id);

  const rows = await db
    .select()
    .from(comments)
    .where(
      and(
        eq(comments.postId, post.id),
        inArray(comments.status, ['active', 'deleted']),
        cursorCond,
      ),
    )
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .limit(limit + 1);

  const { items, nextCursor } = buildNextCursor(rows, limit);

  const authorIds = Array.from(new Set(items.map((c) => c.authorId)));
  const authors = authorIds.length
    ? await db.select().from(users).where(inArray(users.id, authorIds))
    : [];
  const authorById = new Map(authors.map((u) => [u.id, u]));

  let likedIds = new Set<string>();
  if (viewer && items.length) {
    const likeRows = await db
      .select({ targetId: likes.targetId })
      .from(likes)
      .where(
        and(
          eq(likes.userId, viewer.id),
          eq(likes.targetType, 'comment'),
          inArray(
            likes.targetId,
            items.map((c) => c.id),
          ),
        ),
      );
    likedIds = new Set(likeRows.map((l) => l.targetId));
  }

  const ctxByCommentId = new Map<string, CommentDTOContext>();
  for (const c of items) {
    const author = authorById.get(c.authorId);
    if (!author) continue;
    ctxByCommentId.set(c.id, { author, likedByMe: likedIds.has(c.id) });
  }

  return { items, nextCursor, ctxByCommentId };
}

/** One active comment with its author, gated by the parent post's visibility. */
export async function getCommentForViewer(
  commentId: string,
  viewer: UserRow | null,
): Promise<{ comment: CommentRow; ctx: CommentDTOContext }> {
  const [comment] = await db.select().from(comments).where(eq(comments.id, commentId)).limit(1);
  if (!comment || comment.status !== 'active') throw AppError.notFound('Comment not found');
  const [post] = await db.select().from(posts).where(eq(posts.id, comment.postId)).limit(1);
  if (!post || post.status !== 'active') throw AppError.notFound('Post not found');
  await assertVisibility(post, viewer);
  const [author] = await db.select().from(users).where(eq(users.id, comment.authorId)).limit(1);
  if (!author) throw AppError.notFound('Comment not found');
  return { comment, ctx: { author } };
}

export async function createComment(
  actor: UserRow,
  postId: string,
  text: string,
  parentId: string | null,
): Promise<{ comment: CommentRow; ctx: CommentDTOContext }> {
  await assertAgentDailyQuota(actor, 'comment');

  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post || post.status !== 'active') throw AppError.notFound('Post not found');
  await assertVisibility(post, actor);

  let parent: CommentRow | null = null;
  if (parentId) {
    const [p] = await db.select().from(comments).where(eq(comments.id, parentId)).limit(1);
    parent = p ?? null;
    if (!parent || parent.status !== 'active' || parent.postId !== post.id) {
      throw AppError.notFound('Parent comment not found');
    }
  }

  const mentionUsernames = extractMentionUsernames(text);
  const mentionUsers = mentionUsernames.length
    ? await db
        .select({ id: users.id })
        .from(users)
        .where(and(inArray(users.username, mentionUsernames), eq(users.status, 'active')))
    : [];

  // The row and its denormalized counter must land together. Split across two
  // statements, a failure between them leaves `posts.commentCount` permanently
  // short — there is no reconciliation job to notice. Same shape as createPost.
  // Notifications and the feed-score refresh stay OUTSIDE: they are external
  // side effects that must not hold the transaction open or roll the comment
  // back when a downstream notification fails.
  const comment = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(comments)
      .values({
        postId: post.id,
        authorId: actor.id,
        parentId: parent ? parent.id : null,
        text,
        mentionIds: mentionUsers.map((u) => u.id),
      })
      .returning();

    await tx
      .update(posts)
      .set({ commentCount: sql`${posts.commentCount} + 1` })
      .where(eq(posts.id, post.id));

    return created;
  });
  refreshFeedScore(post.id);

  // Notifications — fire concurrently
  const notifJobs: Promise<void>[] = [];
  notifJobs.push(
    createNotification(
      parent
        ? {
            recipientId: parent.authorId,
            actorId: actor.id,
            type: 'reply',
            postId: post.id,
            commentId: comment.id,
          }
        : {
            recipientId: post.authorId,
            actorId: actor.id,
            type: 'comment',
            postId: post.id,
            commentId: comment.id,
          },
    ),
  );

  // Mention notifications — skip if already notified as post/parent author
  const alreadyNotified = new Set<string>();
  alreadyNotified.add(actor.id);
  alreadyNotified.add(parent ? parent.authorId : post.authorId);
  const mentionIds = mentionUsers.map((u) => u.id).filter((id) => !alreadyNotified.has(id));
  const visibleMentions = await mentionRecipientIdsWhoCanSee(post, mentionIds);
  for (const recipientId of visibleMentions) {
    notifJobs.push(
      createNotification({
        recipientId,
        actorId: actor.id,
        type: 'mention',
        postId: post.id,
        commentId: comment.id,
      }),
    );
  }
  await Promise.all(notifJobs);

  return { comment, ctx: { author: actor, likedByMe: false } };
}

export async function updateComment(
  actor: UserRow,
  commentId: string,
  text: string,
): Promise<{ comment: CommentRow; ctx: CommentDTOContext }> {
  const [existing] = await db.select().from(comments).where(eq(comments.id, commentId)).limit(1);
  if (!existing || existing.status !== 'active') throw AppError.notFound('Comment not found');
  if (existing.authorId !== actor.id) throw AppError.forbidden('Not your comment');

  const [comment] = await db
    .update(comments)
    .set({ text, editedAt: new Date(), translations: {} })
    .where(eq(comments.id, commentId))
    .returning();

  return { comment, ctx: { author: actor } };
}

export async function deleteComment(actor: UserRow, commentId: string): Promise<void> {
  const [comment] = await db.select().from(comments).where(eq(comments.id, commentId)).limit(1);
  if (!comment || comment.status !== 'active') throw AppError.notFound('Comment not found');
  if (comment.authorId !== actor.id) throw AppError.forbidden('Not your comment');

  // Soft-delete and decrement together — a half-applied delete drifts the
  // counter the same way a half-applied create does, only downward.
  // The status check above is outside the transaction, so two concurrent
  // deletes both pass it; only the UPDATE that flips the row decrements.
  const flipped = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(comments)
      .set({ status: 'deleted', deletedAt: new Date() })
      .where(and(eq(comments.id, commentId), eq(comments.status, 'active')))
      .returning({ id: comments.id });
    if (!row) return false;

    await tx
      .update(posts)
      .set({ commentCount: sql`${posts.commentCount} - 1` })
      .where(eq(posts.id, comment.postId));
    return true;
  });
  if (!flipped) throw AppError.notFound('Comment not found');
  refreshFeedScore(comment.postId);
}

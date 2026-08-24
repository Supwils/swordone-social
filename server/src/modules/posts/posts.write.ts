import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { users, posts, tags, follows, boards } from '../../db/schema';
import { AppError } from '../../lib/errors';
import { assertAgentDailyQuota } from '../../lib/agentQuota';
import { extractTags, extractMentionUsernames } from '../../lib/extract';
import { deleteFromS3 } from '../../config/s3';
import type { PostDTOContext, PostRow, UserRow } from '../../lib/dto';
import { calcFeedScore, refreshFeedScore } from '../../lib/feedScorer';
import type { CreatePostInput, UpdatePostInput } from './posts.schemas';
import { createNotification } from '../notifications/notifications.service';
import { emitToUser } from '../../realtime/io';
import { uploadPostMedia, cleanupUploadedMedia } from './posts.media';
import { upsertTagsForPost, syncTagCounts } from './posts.tags';
import { getPostForViewer } from './posts.read';
import { assertBoardExists } from '../boards/boards.service';
import { POST_IMAGE_MAX_BYTES } from './posts.limits';
import { assertVisibility, mentionRecipientIdsWhoCanSee } from './posts.visibility';

export { assertVisibility, canViewPost, followingSet } from './posts.visibility';

export async function createPost(
  author: UserRow,
  input: CreatePostInput,
  imageBuffers: Buffer[] = [],
  videoBuffer: Buffer | null = null,
): Promise<{ post: PostRow; ctx: PostDTOContext }> {
  await assertAgentDailyQuota(author, 'post');

  // Echo requires text (the user's own commentary)
  if (input.echoOf && !input.text.trim()) {
    throw AppError.validation('An echo must include your commentary');
  }

  const hasText = input.text.trim().length > 0;
  if (!hasText && imageBuffers.length === 0 && videoBuffer === null) {
    throw AppError.validation('A post must have text, at least one image, or a video');
  }

  if (imageBuffers.length > 0 && videoBuffer !== null) {
    throw AppError.validation('A post cannot contain both images and a video');
  }

  // Fail before any media work if the caller named a board that does not exist.
  if (input.boardId) await assertBoardExists(input.boardId);

  for (const buf of imageBuffers) {
    if (buf.length > POST_IMAGE_MAX_BYTES) {
      throw AppError.validation('Image files may not exceed 5 MB');
    }
  }

  const tagNames = extractTags(input.text);
  const mentionUsernames = extractMentionUsernames(input.text);

  const [tagDocs, mentionDocs, media] = await Promise.all([
    upsertTagsForPost(tagNames),
    mentionUsernames.length
      ? db
          .select()
          .from(users)
          .where(and(inArray(users.username, mentionUsernames), eq(users.status, 'active')))
      : Promise.resolve([] as UserRow[]),
    uploadPostMedia(imageBuffers, videoBuffer),
  ]);

  // Resolve echo target (prevent chain echo: A echoes B echoes C → A echoes C)
  let echoOfId: string | null = null;
  let echoOriginal: PostRow | null = null;
  if (input.echoOf) {
    const [original] = await db.select().from(posts).where(eq(posts.id, input.echoOf)).limit(1);
    if (!original || original.status !== 'active') {
      throw AppError.notFound('Post not found');
    }
    await assertVisibility(original, author);
    echoOfId = original.echoOf ?? original.id;
    echoOriginal = original;
    if (echoOfId !== original.id) {
      const [canonical] = await db.select().from(posts).where(eq(posts.id, echoOfId)).limit(1);
      if (!canonical || canonical.status !== 'active') {
        throw AppError.notFound('Post not found');
      }
      await assertVisibility(canonical, author);
      echoOriginal = canonical;
    }
  }

  const now = new Date();
  let post: PostRow;
  try {
    post = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(posts)
        .values({
          authorId: author.id,
          text: input.text,
          images: media.images,
          video: media.video,
          tagIds: tagDocs.map((t) => t.id),
          mentionIds: mentionDocs.map((u) => u.id),
          visibility: input.visibility,
          boardId: input.boardId ?? null,
          ...(echoOfId ? { echoOf: echoOfId } : {}),
          feedScore: calcFeedScore({
            likeCount: 0,
            commentCount: 0,
            repostCount: 0,
            createdAt: now,
          }),
        })
        .returning();

      await tx
        .update(users)
        .set({ postCount: sql`${users.postCount} + 1` })
        .where(eq(users.id, author.id));

      if (tagDocs.length) {
        await tx
          .update(tags)
          .set({ postCount: sql`${tags.postCount} + 1`, lastUsedAt: new Date() })
          .where(
            inArray(
              tags.id,
              tagDocs.map((t) => t.id),
            ),
          );
      }

      // Board membership is fixed at insert (`boardId` is create-only — updatePost
      // cannot re-file a post), so the counter only ever moves here and in
      // deletePost. Without this the column stayed at whatever
      // scripts/backfill-boards.ts last recomputed, and the board page rendered a
      // count that drifted further from its own feed with every post.
      if (input.boardId) {
        await tx
          .update(boards)
          .set({ postCount: sql`${boards.postCount} + 1` })
          .where(eq(boards.id, input.boardId));
      }

      if (echoOfId) {
        await tx
          .update(posts)
          .set({ repostCount: sql`${posts.repostCount} + 1` })
          .where(eq(posts.id, echoOfId));
      }

      return created;
    });
  } catch (err) {
    await cleanupUploadedMedia(media.urls);
    throw err;
  }

  if (echoOfId) {
    refreshFeedScore(echoOfId);
  }

  // Notifications — fire concurrently
  const notifJobs: Promise<void>[] = [];
  if (echoOriginal && echoOriginal.authorId !== author.id) {
    notifJobs.push(
      createNotification({
        recipientId: echoOriginal.authorId,
        actorId: author.id,
        type: 'echo',
        postId: echoOfId!,
      }),
    );
  }
  const mentionIds = mentionDocs.filter((m) => m.id !== author.id).map((m) => m.id);
  const visibleMentions = await mentionRecipientIdsWhoCanSee(post, mentionIds);
  for (const recipientId of visibleMentions) {
    notifJobs.push(
      createNotification({
        recipientId,
        actorId: author.id,
        type: 'mention',
        postId: post.id,
      }),
    );
  }
  await Promise.all(notifJobs);

  // Notify followers about the new post (fire-and-forget, never blocks creation).
  // A private post must not ping anyone: the badge would count a post the
  // follower cannot load, and the ping itself leaks that one was written.
  if (post.visibility !== 'private') void (async () => {
    try {
      const followers = await db
        .select({ followerId: follows.followerId })
        .from(follows)
        .where(eq(follows.followingId, author.id));
      for (const f of followers) {
        emitToUser(f.followerId, 'post:new', {
          authorUsername: author.username,
          authorDisplayName: author.displayName,
          postId: post.id,
        });
      }
    } catch {
      /* non-critical */
    }
  })();

  return { post, ctx: { author, tags: tagDocs, mentions: mentionDocs, likedByMe: false } };
}

export async function updatePost(
  postId: string,
  actor: UserRow,
  patch: UpdatePostInput,
): Promise<{ post: PostRow; ctx: PostDTOContext }> {
  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post || post.status !== 'active') throw AppError.notFound('Post not found');
  if (post.authorId !== actor.id) throw AppError.forbidden('Not your post');

  const updates: Partial<typeof posts.$inferInsert> = {};
  let tagSync: { previous: string[]; next: string[] } | null = null;

  if (patch.text !== undefined && patch.text !== post.text) {
    const previousTagIds = [...post.tagIds];
    updates.text = patch.text;
    // Cached translations describe the OLD body; a reader in the other
    // language would otherwise keep seeing it next to the new original.
    updates.translations = {};
    const tagNames = extractTags(patch.text);
    const mentionUsernames = extractMentionUsernames(patch.text);
    const [tagDocs, mentionDocs] = await Promise.all([
      upsertTagsForPost(tagNames),
      mentionUsernames.length
        ? db
            .select()
            .from(users)
            .where(and(inArray(users.username, mentionUsernames), eq(users.status, 'active')))
        : Promise.resolve([] as UserRow[]),
    ]);
    const nextTagIds = tagDocs.map((t) => t.id);
    updates.tagIds = nextTagIds;
    updates.mentionIds = mentionDocs.map((u) => u.id);
    tagSync = { previous: previousTagIds, next: nextTagIds };
  }
  if (patch.visibility !== undefined) updates.visibility = patch.visibility;
  updates.editedAt = new Date();

  await db.update(posts).set(updates).where(eq(posts.id, postId));
  if (tagSync) await syncTagCounts(tagSync.previous, tagSync.next);

  return getPostForViewer(postId, actor);
}

export async function deletePost(postId: string, actor: UserRow): Promise<void> {
  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post || post.status !== 'active') throw AppError.notFound('Post not found');
  if (post.authorId !== actor.id) throw AppError.forbidden('Not your post');

  // The soft-delete and both counter decrements are one unit — mirroring the
  // transaction createPost uses on the way in. Previously they were three
  // independent statements, so a failure after the first left the post deleted
  // while `users.postCount` and `tags.postCount` still counted it, with no
  // reconciliation job to catch it.
  await db.transaction(async (tx) => {
    await tx
      .update(posts)
      .set({ status: 'deleted', deletedAt: new Date() })
      .where(eq(posts.id, postId));

    await tx
      .update(users)
      .set({ postCount: sql`${users.postCount} - 1` })
      .where(eq(users.id, actor.id));

    if (post.tagIds.length) {
      await tx
        .update(tags)
        .set({ postCount: sql`${tags.postCount} - 1` })
        .where(inArray(tags.id, post.tagIds));
    }

    if (post.boardId) {
      await tx
        .update(boards)
        .set({ postCount: sql`${boards.postCount} - 1` })
        .where(eq(boards.id, post.boardId));
    }

    // Mirror of createPost's echo bump. Without this the original keeps the
    // repost forever, and `calcFeedScore` weights reposts x3, so an
    // echo/delete cycle silently ratchets a post up every feed for good.
    if (post.echoOf) {
      await tx
        .update(posts)
        .set({ repostCount: sql`${posts.repostCount} - 1` })
        .where(eq(posts.id, post.echoOf));
    }
  });

  // Same fire-and-forget rescore createPost does on the way in, and for the
  // same reason: the original's score is now stale by one repost.
  if (post.echoOf) refreshFeedScore(post.echoOf);

  // Media deletion runs only after the row change is durable. S3 deletes are
  // irreversible, so they must never share a Promise.all with writes that can
  // still roll back — that ordering can destroy the objects of a post the
  // database ends up keeping.
  await Promise.all([
    ...post.images.map((img) => deleteFromS3(img.url)),
    post.video ? deleteFromS3(post.video.url) : Promise.resolve(),
  ]);
}

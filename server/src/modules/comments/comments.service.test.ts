import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { users, posts, comments, notifications, likes, follows } from '../../db/schema';
import { resetDb } from '../../test/db-reset';
import { withForeignKeysOff } from '../../test/orphans';
import { AppError } from '../../lib/errors';
import { decodeCursor } from '../../lib/pagination';
import type { PostRow, UserRow } from '../../lib/dto';
import { createComment, deleteComment, listForPost, updateComment } from './comments.service';

let seq = 0;
async function seedUser(over: Partial<typeof users.$inferInsert> = {}): Promise<UserRow> {
  seq += 1;
  const [u] = await db
    .insert(users)
    .values({
      username: `user${seq}`,
      usernameDisplay: `user${seq}`,
      email: `user${seq}@example.com`,
      displayName: `User ${seq}`,
      ...over,
    })
    .returning();
  return u;
}

async function seedPost(
  authorId: string,
  over: Partial<typeof posts.$inferInsert> = {},
): Promise<PostRow> {
  const [p] = await db
    .insert(posts)
    .values({ authorId, text: 'body', visibility: 'public', ...over })
    .returning();
  return p;
}

describe('comments.service', () => {
  beforeEach(resetDb);

  it('rejects replies whose parent belongs to a different post', async () => {
    const actor = await seedUser();
    const targetPost = await seedPost(actor.id);
    const otherPost = await seedPost(actor.id);
    const [parent] = await db
      .insert(comments)
      .values({ postId: otherPost.id, authorId: actor.id, text: 'root' })
      .returning();

    await expect(createComment(actor, targetPost.id, 'reply', parent.id)).rejects.toMatchObject<
      Partial<AppError>
    >({ code: 'NOT_FOUND', status: 404 });
  });

  it('soft deletes comments and decrements the parent post count', async () => {
    const actor = await seedUser();
    const post = await seedPost(actor.id, { commentCount: 1 });
    const [comment] = await db
      .insert(comments)
      .values({ postId: post.id, authorId: actor.id, text: 'hello' })
      .returning();

    await deleteComment(actor, comment.id);

    const [row] = await db.select().from(comments).where(eq(comments.id, comment.id));
    expect(row.status).toBe('deleted');
    expect(row.deletedAt).toBeInstanceOf(Date);

    const [postRow] = await db.select().from(posts).where(eq(posts.id, post.id));
    expect(postRow.commentCount).toBe(0);
  });

  it('does not notify a mention on a private post the recipient cannot see', async () => {
    const author = await seedUser();
    const mentioned = await seedUser({ username: 'mona', usernameDisplay: 'mona' });
    const post = await seedPost(author.id, { visibility: 'private' });

    await createComment(author, post.id, 'secret @mona');

    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.recipientId, mentioned.id));
    expect(rows).toHaveLength(0);
  });

  it('notifies a mention on a public post comment', async () => {
    const author = await seedUser();
    const mentioned = await seedUser({ username: 'ada', usernameDisplay: 'ada' });
    const post = await seedPost(author.id, { visibility: 'public' });

    await createComment(author, post.id, 'hello @ada');

    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.recipientId, mentioned.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('mention');
  });
});

async function seedComment(
  postId: string,
  authorId: string,
  over: Partial<typeof comments.$inferInsert> = {},
) {
  const [c] = await db
    .insert(comments)
    .values({ postId, authorId, text: 'c', ...over })
    .returning();
  return c;
}

describe('comments.service listForPost', () => {
  beforeEach(resetDb);

  it('lists oldest-first, includes soft-deleted rows, and excludes hidden ones', async () => {
    const author = await seedUser();
    const post = await seedPost(author.id);
    const c1 = await seedComment(post.id, author.id, {
      createdAt: new Date('2026-01-01T00:00:01Z'),
    });
    const c2 = await seedComment(post.id, author.id, {
      createdAt: new Date('2026-01-01T00:00:02Z'),
      status: 'deleted',
    });
    const hidden = await seedComment(post.id, author.id, {
      createdAt: new Date('2026-01-01T00:00:03Z'),
      status: 'hidden',
    });

    const { items, nextCursor } = await listForPost(post.id, null, null, 10);

    expect(items.map((c) => c.id)).toEqual([c1.id, c2.id]);
    expect(items.map((c) => c.id)).not.toContain(hidden.id);
    expect(nextCursor).toBeNull();
  });

  it('paginates with a cursor, breaking created-at ties by id', async () => {
    const author = await seedUser();
    const post = await seedPost(author.id);
    const t = new Date('2026-01-01T00:00:01.000Z');
    const a = await seedComment(post.id, author.id, { createdAt: t });
    const b = await seedComment(post.id, author.id, { createdAt: t });
    // Identical timestamps: the contract breaks the tie by id ascending.
    const [first, second] = [a, b].sort((x, y) => (x.id < y.id ? -1 : 1));

    const page1 = await listForPost(post.id, null, null, 1);
    expect(page1.items.map((c) => c.id)).toEqual([first.id]);
    const cursor = decodeCursor(page1.nextCursor);
    expect(cursor).toEqual({ t: first.createdAt.toISOString(), id: first.id });

    const page2 = await listForPost(post.id, null, cursor, 1);
    expect(page2.items.map((c) => c.id)).toEqual([second.id]);
    expect(page2.nextCursor).toBeNull();
  });

  it('marks likedByMe only for the comments the viewer liked', async () => {
    const author = await seedUser();
    const viewer = await seedUser();
    const post = await seedPost(author.id);
    const liked = await seedComment(post.id, author.id);
    const other = await seedComment(post.id, author.id);
    await db.insert(likes).values({ userId: viewer.id, targetType: 'comment', targetId: liked.id });

    const { ctxByCommentId } = await listForPost(post.id, viewer, null, 10);

    expect(ctxByCommentId.get(liked.id)?.likedByMe).toBe(true);
    expect(ctxByCommentId.get(other.id)?.likedByMe).toBe(false);
    expect(ctxByCommentId.get(liked.id)?.author.id).toBe(author.id);
  });

  it('serves an anonymous viewer with likedByMe false everywhere', async () => {
    const author = await seedUser();
    const post = await seedPost(author.id);
    const c = await seedComment(post.id, author.id);
    await db.insert(likes).values({ userId: author.id, targetType: 'comment', targetId: c.id });

    const { ctxByCommentId } = await listForPost(post.id, null, null, 10);
    expect(ctxByCommentId.get(c.id)?.likedByMe).toBe(false);
  });

  it('omits ctx (but keeps the row) when the author account no longer exists', async () => {
    const author = await seedUser();
    const post = await seedPost(author.id);
    // Users are tombstoned, never deleted, and comments.author_id is a FK — a
    // missing author is only a historical orphan (0006 is NOT VALID), written
    // here with the FK triggers off.
    const [c] = await withForeignKeysOff((tx) =>
      tx
        .insert(comments)
        .values({ postId: post.id, authorId: 'f'.repeat(24), text: 'c' })
        .returning(),
    );

    const { items, ctxByCommentId } = await listForPost(post.id, null, null, 10);
    expect(items.map((x) => x.id)).toEqual([c.id]);
    expect(ctxByCommentId.has(c.id)).toBe(false);
  });

  it('404s for a missing post and for a non-active post', async () => {
    const author = await seedUser();
    const gone = await seedPost(author.id, { status: 'deleted' });

    await expect(listForPost('0'.repeat(24), null, null, 10)).rejects.toThrow('Post not found');
    await expect(listForPost(gone.id, null, null, 10)).rejects.toThrow('Post not found');
  });

  it('hides a followers-only post from outsiders but serves a follower', async () => {
    const author = await seedUser();
    const outsider = await seedUser();
    const follower = await seedUser();
    const post = await seedPost(author.id, { visibility: 'followers' });
    await seedComment(post.id, author.id);
    await db.insert(follows).values({ followerId: follower.id, followingId: author.id });

    // NOT_FOUND (never FORBIDDEN) so the post's existence does not leak.
    await expect(listForPost(post.id, outsider, null, 10)).rejects.toThrow('Post not found');
    await expect(listForPost(post.id, null, null, 10)).rejects.toThrow('Post not found');
    const { items } = await listForPost(post.id, follower, null, 10);
    expect(items).toHaveLength(1);
  });
});

describe('comments.service update/delete guards', () => {
  beforeEach(resetDb);

  it('edits own comment text and stamps editedAt', async () => {
    const author = await seedUser();
    const post = await seedPost(author.id);
    const { comment } = await createComment(author, post.id, 'before', null);
    expect(comment.editedAt).toBeNull();

    const updated = await updateComment(author, comment.id, 'after');

    expect(updated.comment.text).toBe('after');
    expect(updated.comment.editedAt).not.toBeNull();
  });

  it("rejects editing someone else's comment", async () => {
    const author = await seedUser();
    const stranger = await seedUser();
    const post = await seedPost(author.id);
    const { comment } = await createComment(author, post.id, 'x', null);

    await expect(updateComment(stranger, comment.id, 'y')).rejects.toThrow('Not your comment');
  });

  it('404s when editing a comment that was already deleted', async () => {
    const author = await seedUser();
    const post = await seedPost(author.id);
    const { comment } = await createComment(author, post.id, 'x', null);
    await deleteComment(author, comment.id);

    await expect(updateComment(author, comment.id, 'y')).rejects.toThrow('Comment not found');
  });

  it("rejects deleting someone else's comment", async () => {
    const author = await seedUser();
    const stranger = await seedUser();
    const post = await seedPost(author.id);
    const { comment } = await createComment(author, post.id, 'x', null);

    await expect(deleteComment(stranger, comment.id)).rejects.toThrow('Not your comment');
  });
});

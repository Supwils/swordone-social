import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { users, posts, comments, likes } from '../../db/schema';
import { resetDb } from '../../test/db-reset';
import type { PostRow, UserRow } from '../../lib/dto';
import * as notifications from '../notifications/notifications.service';
import { like, unlike } from './likes.service';

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

describe('likes.service', () => {
  beforeEach(resetDb);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the existing count when a like races with a duplicate insert', async () => {
    const actor = await seedUser();
    const author = await seedUser();
    const post = await seedPost(author.id, { likeCount: 4 });
    // Pre-existing like — a second like() must hit onConflictDoNothing and NOT bump.
    await db.insert(likes).values({ userId: actor.id, targetType: 'post', targetId: post.id });

    const out = await like(actor, 'post', post.id);

    expect(out).toEqual({ likeCount: 4, liked: true });
    const [row] = await db.select().from(posts).where(eq(posts.id, post.id));
    expect(row.likeCount).toBe(4); // unchanged — no double count
  });

  it('notifies the target owner after a successful post like', async () => {
    const owner = await seedUser();
    const actor = await seedUser();
    const post = await seedPost(owner.id, { likeCount: 0 });
    const notify = vi.spyOn(notifications, 'createNotification').mockResolvedValue(undefined);

    const out = await like(actor, 'post', post.id);

    expect(out).toEqual({ likeCount: 1, liked: true });
    expect(notify).toHaveBeenCalledWith({
      recipientId: owner.id,
      actorId: actor.id,
      type: 'like',
      postId: post.id,
    });
    const [row] = await db.select().from(posts).where(eq(posts.id, post.id));
    expect(row.likeCount).toBe(1);
    // The edge was actually persisted.
    const likeRows = await db
      .select()
      .from(likes)
      .where(
        and(eq(likes.userId, actor.id), eq(likes.targetType, 'post'), eq(likes.targetId, post.id)),
      );
    expect(likeRows).toHaveLength(1);
  });

  it('treats unlike as idempotent when the edge is already gone', async () => {
    const actor = await seedUser();
    const author = await seedUser();
    const post = await seedPost(author.id, { likeCount: 2 });

    const out = await unlike(actor, 'post', post.id);

    expect(out).toEqual({ likeCount: 2, liked: false });
    const [row] = await db.select().from(posts).where(eq(posts.id, post.id));
    expect(row.likeCount).toBe(2); // unchanged
  });

  it('notifies comment owners when liking a comment', async () => {
    const owner = await seedUser();
    const actor = await seedUser();
    const post = await seedPost(owner.id);
    const [comment] = await db
      .insert(comments)
      .values({ postId: post.id, authorId: owner.id, text: 'hi', likeCount: 2 })
      .returning();
    const notify = vi.spyOn(notifications, 'createNotification').mockResolvedValue(undefined);

    const out = await like(actor, 'comment', comment.id);

    expect(out).toEqual({ likeCount: 3, liked: true });
    expect(notify).toHaveBeenCalledWith({
      recipientId: owner.id,
      actorId: actor.id,
      type: 'like',
      postId: post.id,
      commentId: comment.id,
    });
  });

  it('rejects liking a private post the viewer cannot see', async () => {
    const author = await seedUser();
    const stranger = await seedUser();
    const secret = await seedPost(author.id, { visibility: 'private' });

    await expect(like(stranger, 'post', secret.id)).rejects.toMatchObject({ status: 404 });

    const likeRows = await db.select().from(likes).where(eq(likes.targetId, secret.id));
    expect(likeRows).toHaveLength(0);
  });

  it('lets the author like their own private post', async () => {
    const author = await seedUser();
    const secret = await seedPost(author.id, { visibility: 'private', likeCount: 0 });

    const out = await like(author, 'post', secret.id);

    expect(out).toEqual({ likeCount: 1, liked: true });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { users, posts, notifications as notificationsTable } from '../../db/schema';
import { resetDb } from '../../test/db-reset';
import { newId } from '../../lib/id';
import * as realtime from '../../realtime/io';
import type { PostRow, UserRow } from '../../lib/dto';
import type { NotificationType } from '../../contract/messaging';
import {
  buildUpdatedCursorPage,
  clearAll,
  createNotification,
  list,
  markRead,
  toNotificationDTO,
  unreadCount,
} from './notifications.service';
import { decodeCursor } from '../../lib/pagination';
import { toUserLiteDTO } from '../../lib/dto';
import { expectContract } from '../../test/contract';
import {
  NOTIFICATION_TYPES,
  NotificationDTOSchema,
  notificationTypeSchema,
} from '../../contract/messaging';

type NotificationRow = typeof notificationsTable.$inferSelect;

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

async function seedNotification(
  recipientId: string,
  actorId: string,
  over: Partial<typeof notificationsTable.$inferInsert> = {},
): Promise<NotificationRow> {
  const [n] = await db
    .insert(notificationsTable)
    .values({ recipientId, actorId, type: 'like' as NotificationType, read: false, ...over })
    .returning();
  return n;
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

describe('buildUpdatedCursorPage', () => {
  it('builds the next cursor from updatedAt rather than createdAt', () => {
    const docs = [
      {
        id: newId(),
        createdAt: new Date('2026-04-20T00:00:00.000Z'),
        updatedAt: new Date('2026-04-23T10:00:00.000Z'),
      },
      {
        id: newId(),
        createdAt: new Date('2026-04-19T00:00:00.000Z'),
        updatedAt: new Date('2026-04-23T09:00:00.000Z'),
      },
    ] as unknown as NotificationRow[];

    const page = buildUpdatedCursorPage(docs, 1);
    const cursor = decodeCursor(page.nextCursor);

    expect(page.items).toHaveLength(1);
    expect(cursor?.t).toBe('2026-04-23T10:00:00.000Z');
    expect(cursor?.id).toBe(docs[0].id);
  });
});

describe('markRead', () => {
  beforeEach(resetDb);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('marks all unread notifications read without touching another recipient', async () => {
    const viewer = await seedUser();
    const actor = await seedUser();
    const stranger = await seedUser();
    const a = await seedNotification(viewer.id, actor.id, { type: 'like' });
    const b = await seedNotification(viewer.id, actor.id, { type: 'comment' });
    const other = await seedNotification(stranger.id, actor.id, { type: 'follow' });
    const emit = vi.spyOn(realtime, 'emitToUser').mockImplementation(() => undefined);

    await markRead(viewer, 'all');

    const rows = await db
      .select()
      .from(notificationsTable)
      .where(eq(notificationsTable.recipientId, viewer.id));
    for (const r of rows) {
      expect(r.read).toBe(true);
      expect(r.readAt).toBeInstanceOf(Date);
    }
    expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());

    const [otherRow] = await db
      .select()
      .from(notificationsTable)
      .where(eq(notificationsTable.id, other.id));
    expect(otherRow.read).toBe(false); // stranger's notification untouched

    expect(emit).toHaveBeenCalledWith(viewer.id, 'notification:read', { ids: 'all' });
  });

  it('marks only the specified ids read', async () => {
    const viewer = await seedUser();
    const actor = await seedUser();
    const target = await seedNotification(viewer.id, actor.id, { type: 'like' });
    const untouched = await seedNotification(viewer.id, actor.id, { type: 'comment' });
    const emit = vi.spyOn(realtime, 'emitToUser').mockImplementation(() => undefined);

    await markRead(viewer, [target.id]);

    const [targetRow] = await db
      .select()
      .from(notificationsTable)
      .where(eq(notificationsTable.id, target.id));
    expect(targetRow.read).toBe(true);
    expect(targetRow.readAt).toBeInstanceOf(Date);

    const [untouchedRow] = await db
      .select()
      .from(notificationsTable)
      .where(and(eq(notificationsTable.id, untouched.id)));
    expect(untouchedRow.read).toBe(false);

    expect(emit).toHaveBeenCalledWith(viewer.id, 'notification:read', { ids: [target.id] });
  });

  it('leaves an already-read notification untouched but still emits', async () => {
    const viewer = await seedUser();
    const actor = await seedUser();
    const already = await seedNotification(viewer.id, actor.id, {
      type: 'like',
      read: true,
      readAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const emit = vi.spyOn(realtime, 'emitToUser').mockImplementation(() => undefined);

    await markRead(viewer, [already.id]);

    const [row] = await db
      .select()
      .from(notificationsTable)
      .where(eq(notificationsTable.id, already.id));
    expect(row.read).toBe(true);
    // readAt not overwritten because the `read = false` filter excludes it.
    expect(row.readAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(emit).toHaveBeenCalledWith(viewer.id, 'notification:read', { ids: [already.id] });
  });

  it('is a no-op for an empty id list but still emits', async () => {
    const viewer = await seedUser();
    const actor = await seedUser();
    const notif = await seedNotification(viewer.id, actor.id, { type: 'like', read: false });
    const emit = vi.spyOn(realtime, 'emitToUser').mockImplementation(() => undefined);

    await markRead(viewer, []);

    const [row] = await db
      .select()
      .from(notificationsTable)
      .where(eq(notificationsTable.id, notif.id));
    expect(row.read).toBe(false);
    expect(emit).toHaveBeenCalledWith(viewer.id, 'notification:read', { ids: [] });
  });
});

describe('createNotification', () => {
  beforeEach(resetDb);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('inserts a fresh notification and emits the hydrated DTO to the recipient', async () => {
    const recipient = await seedUser();
    const actor = await seedUser();
    const post = await seedPost(actor.id, { text: 'a brand new post' });
    const emit = vi.spyOn(realtime, 'emitToUser').mockImplementation(() => undefined);

    await createNotification({
      recipientId: recipient.id,
      actorId: actor.id,
      type: 'like',
      postId: post.id,
    });

    const rows = await db
      .select()
      .from(notificationsTable)
      .where(eq(notificationsTable.recipientId, recipient.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: actor.id,
      type: 'like',
      postId: post.id,
      read: false,
    });
    expect(rows[0].commentId).toBeNull();
    expect(emit).toHaveBeenCalledWith(
      recipient.id,
      'notification',
      expect.objectContaining({ type: 'like', post: expect.objectContaining({ id: post.id }) }),
    );
  });

  it('dedups a second identical notification within 24h (updates instead of inserting)', async () => {
    const recipient = await seedUser();
    const actor = await seedUser();
    const post = await seedPost(actor.id);
    vi.spyOn(realtime, 'emitToUser').mockImplementation(() => undefined);

    await createNotification({
      recipientId: recipient.id,
      actorId: actor.id,
      type: 'like',
      postId: post.id,
    });
    // Recipient reads it; a repeat like within the window should bump it back to unread.
    await db
      .update(notificationsTable)
      .set({ read: true, readAt: new Date() })
      .where(eq(notificationsTable.recipientId, recipient.id));

    await createNotification({
      recipientId: recipient.id,
      actorId: actor.id,
      type: 'like',
      postId: post.id,
    });

    const rows = await db
      .select()
      .from(notificationsTable)
      .where(eq(notificationsTable.recipientId, recipient.id));
    expect(rows).toHaveLength(1); // updated, not inserted
    expect(rows[0].read).toBe(false);
    expect(rows[0].readAt).toBeNull();
  });

  it('never creates a self-notification', async () => {
    const user = await seedUser();
    const emit = vi.spyOn(realtime, 'emitToUser').mockImplementation(() => undefined);

    await createNotification({
      recipientId: user.id,
      actorId: user.id,
      type: 'like',
      postId: newId(),
    });

    const rows = await db.select().from(notificationsTable);
    expect(rows).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it('dedups per distinct target via matchNullable (null vs non-null ref fields)', async () => {
    const recipient = await seedUser();
    const actor = await seedUser();
    const p1 = await seedPost(actor.id);
    const p2 = await seedPost(actor.id);
    vi.spyOn(realtime, 'emitToUser').mockImplementation(() => undefined);

    // non-null postId (eq), null comment/message/conversation (isNull)
    await createNotification({
      recipientId: recipient.id,
      actorId: actor.id,
      type: 'like',
      postId: p1.id,
    });
    await createNotification({
      recipientId: recipient.id,
      actorId: actor.id,
      type: 'like',
      postId: p1.id,
    }); // dedup
    // different post target → separate row (matchNullable eq distinguishes)
    await createNotification({
      recipientId: recipient.id,
      actorId: actor.id,
      type: 'like',
      postId: p2.id,
    });
    // non-null commentId, null post/message/conversation
    await createNotification({
      recipientId: recipient.id,
      actorId: actor.id,
      type: 'comment',
      commentId: newId(),
    });
    // non-null message + conversation, null post/comment
    await createNotification({
      recipientId: recipient.id,
      actorId: actor.id,
      type: 'message',
      messageId: newId(),
      conversationId: newId(),
    });
    // all-null targets (isNull on all four ref columns)
    await createNotification({ recipientId: recipient.id, actorId: actor.id, type: 'follow' });
    await createNotification({ recipientId: recipient.id, actorId: actor.id, type: 'follow' }); // dedup

    const rows = await db
      .select()
      .from(notificationsTable)
      .where(eq(notificationsTable.recipientId, recipient.id));
    expect(rows).toHaveLength(5);
  });
});

describe('list', () => {
  beforeEach(resetDb);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('paginates newest-first (by updatedAt) and walks the cursor to the next page', async () => {
    const viewer = await seedUser();
    const actor = await seedUser();
    const base = Date.parse('2026-05-01T00:00:00.000Z');
    const n1 = await seedNotification(viewer.id, actor.id, {
      type: 'like',
      createdAt: new Date(base + 1000),
      updatedAt: new Date(base + 1000),
    });
    const n2 = await seedNotification(viewer.id, actor.id, {
      type: 'comment',
      createdAt: new Date(base + 2000),
      updatedAt: new Date(base + 2000),
    });
    const n3 = await seedNotification(viewer.id, actor.id, {
      type: 'follow',
      createdAt: new Date(base + 3000),
      updatedAt: new Date(base + 3000),
    });

    const page1 = await list(viewer, null, 2, false);
    expect(page1.items.map((i) => i.id)).toEqual([n3.id, n2.id]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await list(viewer, decodeCursor(page1.nextCursor), 2, false);
    expect(page2.items.map((i) => i.id)).toEqual([n1.id]);
    expect(page2.nextCursor).toBeNull();
  });

  it('filters to unread only when requested', async () => {
    const viewer = await seedUser();
    const actor = await seedUser();
    const unread = await seedNotification(viewer.id, actor.id, { type: 'like', read: false });
    await seedNotification(viewer.id, actor.id, { type: 'comment', read: true });

    const all = await list(viewer, null, 10, false);
    expect(all.items).toHaveLength(2);

    const onlyUnread = await list(viewer, null, 10, true);
    expect(onlyUnread.items.map((i) => i.id)).toEqual([unread.id]);
  });
});

describe('toNotificationDTO', () => {
  const at = new Date('2026-10-01T00:00:00.000Z');
  const row = (over: Partial<NotificationRow> = {}): NotificationRow => ({
    id: newId(),
    recipientId: newId(),
    actorId: newId(),
    type: 'like',
    postId: null,
    commentId: null,
    messageId: null,
    conversationId: null,
    read: false,
    readAt: null,
    createdAt: at,
    updatedAt: new Date('2026-10-02T00:00:00.000Z'),
    ...over,
  });
  const actor = toUserLiteDTO({
    id: newId(),
    username: 'ada',
    usernameDisplay: 'ada',
    displayName: 'Ada',
    avatarUrl: null,
    headline: '',
    profileTags: [],
    isAgent: false,
    archivedAt: null,
  } as unknown as UserRow);

  it('parses for every type, bare and with post / comment / message refs', () => {
    for (const type of NOTIFICATION_TYPES) {
      expectContract(notificationTypeSchema, type);
      expectContract(NotificationDTOSchema, toNotificationDTO(row({ type }), actor));
    }
    const full = toNotificationDTO(
      row({
        type: 'reply',
        postId: newId(),
        commentId: newId(),
        messageId: newId(),
        conversationId: newId(),
        read: true,
      }),
      actor,
      'p'.repeat(200),
      undefined,
    );
    const parsed = expectContract(NotificationDTOSchema, full);
    expect(parsed.post?.textPreview).toHaveLength(81);
    expect(parsed.comment?.textPreview).toBe('');
    expect(parsed.createdAt).toBe('2026-10-02T00:00:00.000Z');
  });

  it('can fail: an unknown type is rejected', () => {
    expect(() =>
      expectContract(NotificationDTOSchema, {
        ...toNotificationDTO(row(), actor),
        type: 'poke',
      }),
    ).toThrow('type:');
  });
});

describe('clearAll', () => {
  beforeEach(resetDb);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('deletes only the viewer notifications and emits a clear event', async () => {
    const viewer = await seedUser();
    const stranger = await seedUser();
    const actor = await seedUser();
    await seedNotification(viewer.id, actor.id, { type: 'like' });
    await seedNotification(viewer.id, actor.id, { type: 'comment' });
    const strangerNotif = await seedNotification(stranger.id, actor.id, { type: 'follow' });
    const emit = vi.spyOn(realtime, 'emitToUser').mockImplementation(() => undefined);

    await clearAll(viewer);

    const viewerRows = await db
      .select()
      .from(notificationsTable)
      .where(eq(notificationsTable.recipientId, viewer.id));
    expect(viewerRows).toHaveLength(0);

    const strangerRows = await db
      .select()
      .from(notificationsTable)
      .where(eq(notificationsTable.recipientId, stranger.id));
    expect(strangerRows.map((r) => r.id)).toEqual([strangerNotif.id]);

    expect(emit).toHaveBeenCalledWith(viewer.id, 'notification:read', { ids: 'all' });
  });
});

describe('unreadCount', () => {
  beforeEach(resetDb);

  it('returns 0 when there are no unread notifications', async () => {
    const viewer = await seedUser();
    expect(await unreadCount(viewer)).toBe(0);
  });

  it('counts only the viewer unread notifications', async () => {
    const viewer = await seedUser();
    const actor = await seedUser();
    await seedNotification(viewer.id, actor.id, { type: 'like', read: false });
    await seedNotification(viewer.id, actor.id, { type: 'comment', read: false });
    await seedNotification(viewer.id, actor.id, { type: 'follow', read: true });
    // another recipient's unread must not be counted
    const stranger = await seedUser();
    await seedNotification(stranger.id, actor.id, { type: 'like', read: false });

    expect(await unreadCount(viewer)).toBe(2);
  });
});

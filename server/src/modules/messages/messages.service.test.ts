import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { users, conversations, messages } from '../../db/schema';
import { resetDb } from '../../test/db-reset';
import { decodeCursor } from '../../lib/pagination';
import type { ConversationRow, UserRow } from '../../lib/dto';
import * as notifications from '../notifications/notifications.service';
import * as realtime from '../../realtime/io';
import {
  findOrCreateWith,
  getById,
  listForViewer,
  listMessages,
  markRead,
  openConversation,
  send,
  unreadCount,
} from './messages.service';

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

async function seedConversation(
  participantIds: string[],
  over: Partial<typeof conversations.$inferInsert> = {},
): Promise<ConversationRow> {
  seq += 1;
  const [c] = await db
    .insert(conversations)
    .values({ participantIds, participantKey: `key-${seq}`, ...over })
    .returning();
  return c;
}

describe('messages.service', () => {
  beforeEach(resetDb);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the existing conversation on a repeat findOrCreate (created: false)', async () => {
    const me = await seedUser();
    const recipient = await seedUser({ username: 'bob', usernameDisplay: 'bob' });

    const first = await findOrCreateWith(me, recipient.username);
    expect(first.created).toBe(true);

    const second = await findOrCreateWith(me, recipient.username);
    expect(second.created).toBe(false);
    expect(second.conversation.id).toBe(first.conversation.id);
  });

  it('openConversation returns the viewer DTO with both participants, 201-then-200', async () => {
    const me = await seedUser();
    const bob = await seedUser({ username: 'bobopen', usernameDisplay: 'bobopen' });

    const first = await openConversation(me, 'bobopen');
    expect(first.created).toBe(true);
    expect(first.conversation.participants.map((p) => p.username).sort()).toEqual(
      [me.username, bob.username].sort(),
    );
    expect(first.conversation.lastMessage).toBeNull();

    const second = await openConversation(me, 'BobOpen');
    expect(second).toMatchObject({ created: false, conversation: { id: first.conversation.id } });
  });

  it('counts unread conversations for a viewer', async () => {
    const me = await seedUser();
    const other = await seedUser();
    await seedConversation([me.id, other.id], { unreadBy: [me.id] });
    await seedConversation([me.id, other.id], { unreadBy: [me.id] });
    await seedConversation([me.id, other.id], { unreadBy: [me.id] });
    await seedConversation([me.id, other.id], { unreadBy: [] }); // read
    await seedConversation([other.id], { unreadBy: [other.id] }); // not a participant

    const count = await unreadCount(me);

    expect(count).toBe(3);
  });

  it('sends a message, updates unread state, and emits realtime events', async () => {
    const me = await seedUser();
    const recipient = await seedUser();
    const convo = await seedConversation([me.id, recipient.id], { unreadBy: [] });

    const emitToConversation = vi
      .spyOn(realtime, 'emitToConversation')
      .mockImplementation(() => undefined);
    const emitToUser = vi.spyOn(realtime, 'emitToUser').mockImplementation(() => undefined);
    const notify = vi.spyOn(notifications, 'createNotification').mockResolvedValue(undefined);

    const out = await send(me, convo.id, 'hello');

    expect(out.text).toBe('hello');
    expect(out.readBy).toEqual([me.id]);

    // Message persisted.
    const [msgRow] = await db.select().from(messages).where(eq(messages.id, out.id));
    expect(msgRow.text).toBe('hello');
    expect(msgRow.readBy).toEqual([me.id]);

    // Conversation unread + last-message pointers updated.
    const [convoRow] = await db.select().from(conversations).where(eq(conversations.id, convo.id));
    expect(convoRow.lastMessageId).toBe(out.id);
    expect(convoRow.unreadBy).toContain(recipient.id);

    expect(emitToConversation).toHaveBeenCalledWith(convo.id, 'message', out);
    expect(emitToUser).toHaveBeenCalledWith(recipient.id, 'conversation:update', {
      conversationId: convo.id,
    });
    expect(notify).toHaveBeenCalledWith({
      recipientId: recipient.id,
      actorId: me.id,
      type: 'message',
      messageId: out.id,
      conversationId: convo.id,
    });
  });

  it('marks a conversation read and emits the read receipt event', async () => {
    const me = await seedUser();
    const other = await seedUser();
    const convo = await seedConversation([me.id, other.id], { unreadBy: [me.id] });
    await db
      .insert(messages)
      .values({ conversationId: convo.id, senderId: other.id, text: 'hi', readBy: [other.id] });
    const emit = vi.spyOn(realtime, 'emitToConversation').mockImplementation(() => undefined);

    await markRead(me, convo.id);

    const [convoRow] = await db.select().from(conversations).where(eq(conversations.id, convo.id));
    expect(convoRow.unreadBy).not.toContain(me.id);

    const [msgRow] = await db.select().from(messages).where(eq(messages.conversationId, convo.id));
    expect(msgRow.readBy).toContain(me.id);

    expect(emit).toHaveBeenCalledWith(convo.id, 'message:read', {
      conversationId: convo.id,
      userId: me.id,
      at: expect.any(String),
    });
  });

  // ── findOrCreateWith error paths ──────────────────────────────────────────

  it('throws NOT_FOUND when messaging a user that does not exist', async () => {
    const me = await seedUser();
    await expect(findOrCreateWith(me, 'ghost')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });

  it('rejects starting a conversation with yourself', async () => {
    const me = await seedUser({ username: 'self', usernameDisplay: 'self' });
    await expect(findOrCreateWith(me, 'self')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
    });
  });

  it('creates a new conversation with the deterministic participant pair', async () => {
    const me = await seedUser();
    const recipient = await seedUser({ username: 'bob', usernameDisplay: 'bob' });

    const { conversation, created } = await findOrCreateWith(me, 'BOB');

    expect(created).toBe(true);
    expect(conversation.participantIds.sort()).toEqual([me.id, recipient.id].sort());

    const [row] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversation.id));
    expect(row).toBeDefined();
  });

  // ── listForViewer (conversation list) ─────────────────────────────────────

  it('lists a viewer conversations newest-first and paginates by cursor', async () => {
    const me = await seedUser();
    const other = await seedUser();
    const third = await seedUser();
    const older = await seedConversation([me.id, other.id], {
      lastMessageAt: new Date('2026-01-01T00:00:00Z'),
    });
    const newer = await seedConversation([me.id, other.id], {
      lastMessageAt: new Date('2026-02-01T00:00:00Z'),
    });
    // A conversation the viewer is not part of must never surface.
    await seedConversation([other.id, third.id], {
      lastMessageAt: new Date('2026-03-01T00:00:00Z'),
    });

    const page1 = await listForViewer(me, null, 1);
    expect(page1.items.map((c) => c.id)).toEqual([newer.id]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listForViewer(me, decodeCursor(page1.nextCursor), 1);
    expect(page2.items.map((c) => c.id)).toEqual([older.id]);
    expect(page2.nextCursor).toBeNull();
  });

  it('returns an empty conversation list for a viewer with none', async () => {
    const me = await seedUser();
    const page = await listForViewer(me, null, 20);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('hydrates the last message into the conversation list item', async () => {
    const me = await seedUser();
    const other = await seedUser();
    const convo = await seedConversation([me.id, other.id], { unreadBy: [me.id] });
    const [msg] = await db
      .insert(messages)
      .values({ conversationId: convo.id, senderId: other.id, text: 'yo', readBy: [other.id] })
      .returning();
    await db
      .update(conversations)
      .set({ lastMessageId: msg.id })
      .where(eq(conversations.id, convo.id));

    const page = await listForViewer(me, null, 20);
    expect(page.items[0].lastMessage?.text).toBe('yo');
    expect(page.items[0].unread).toBe(true);
  });

  // ── getById ───────────────────────────────────────────────────────────────

  it('returns a conversation with its last message for a member', async () => {
    const me = await seedUser();
    const other = await seedUser();
    const convo = await seedConversation([me.id, other.id], { unreadBy: [me.id] });
    const [msg] = await db
      .insert(messages)
      .values({
        conversationId: convo.id,
        senderId: other.id,
        text: 'hey there',
        readBy: [other.id],
      })
      .returning();
    await db
      .update(conversations)
      .set({ lastMessageId: msg.id })
      .where(eq(conversations.id, convo.id));

    const dto = await getById(me, convo.id);

    expect(dto.id).toBe(convo.id);
    expect(dto.lastMessage?.text).toBe('hey there');
    expect(dto.unread).toBe(true);
    expect(dto.participants.map((p) => p.id).sort()).toEqual([me.id, other.id].sort());
  });

  it('throws NOT_FOUND from getById for a non-member', async () => {
    const me = await seedUser();
    const other = await seedUser();
    const stranger = await seedUser();
    const convo = await seedConversation([other.id, stranger.id]);

    await expect(getById(me, convo.id)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  // ── listMessages ──────────────────────────────────────────────────────────

  it('lists messages newest-first, paginates, and hides deleted-for-viewer ones', async () => {
    const me = await seedUser();
    const other = await seedUser();
    const convo = await seedConversation([me.id, other.id]);
    const base = Date.parse('2026-01-01T00:00:00Z');
    await db.insert(messages).values([
      { conversationId: convo.id, senderId: other.id, text: 'first', createdAt: new Date(base) },
      {
        conversationId: convo.id,
        senderId: me.id,
        text: 'second',
        createdAt: new Date(base + 1000),
      },
      {
        conversationId: convo.id,
        senderId: other.id,
        text: 'third',
        createdAt: new Date(base + 2000),
      },
      {
        conversationId: convo.id,
        senderId: other.id,
        text: 'hidden',
        createdAt: new Date(base + 3000),
        deletedFor: [me.id],
      },
    ]);

    const page1 = await listMessages(me, convo.id, null, 2);
    expect(page1.items.map((m) => m.text)).toEqual(['third', 'second']);
    expect(page1.items[0].sender.id).toBe(other.id);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listMessages(me, convo.id, decodeCursor(page1.nextCursor), 2);
    expect(page2.items.map((m) => m.text)).toEqual(['first']);
    expect(page2.nextCursor).toBeNull();
  });

  it('throws NOT_FOUND from listMessages for a non-member', async () => {
    const me = await seedUser();
    const other = await seedUser();
    const stranger = await seedUser();
    const convo = await seedConversation([other.id, stranger.id]);

    await expect(listMessages(me, convo.id, null, 20)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  // ── send edge cases ───────────────────────────────────────────────────────

  it('unions unreadBy without duplicating an already-unread recipient', async () => {
    const me = await seedUser();
    const recipient = await seedUser();
    const convo = await seedConversation([me.id, recipient.id], { unreadBy: [recipient.id] });
    vi.spyOn(realtime, 'emitToConversation').mockImplementation(() => undefined);
    vi.spyOn(realtime, 'emitToUser').mockImplementation(() => undefined);
    vi.spyOn(notifications, 'createNotification').mockResolvedValue(undefined);

    const out = await send(me, convo.id, 'hey');

    const [row] = await db.select().from(conversations).where(eq(conversations.id, convo.id));
    expect(row.unreadBy.filter((id) => id === recipient.id)).toHaveLength(1);
    expect(row.lastMessageId).toBe(out.id);
    expect(row.lastMessageAt.getTime()).toBeGreaterThan(0);
  });

  it('rejects sending to a conversation the sender is not part of', async () => {
    const me = await seedUser();
    const other = await seedUser();
    const stranger = await seedUser();
    const convo = await seedConversation([other.id, stranger.id]);

    await expect(send(me, convo.id, 'hi')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // ── markRead dup-guard ────────────────────────────────────────────────────

  it('does not double-append readBy when the viewer already read a message', async () => {
    const me = await seedUser();
    const other = await seedUser();
    const convo = await seedConversation([me.id, other.id], { unreadBy: [me.id] });
    await db.insert(messages).values([
      { conversationId: convo.id, senderId: other.id, text: 'already', readBy: [other.id, me.id] },
      { conversationId: convo.id, senderId: other.id, text: 'fresh', readBy: [other.id] },
    ]);
    vi.spyOn(realtime, 'emitToConversation').mockImplementation(() => undefined);

    await markRead(me, convo.id);

    const rows = await db.select().from(messages).where(eq(messages.conversationId, convo.id));
    for (const r of rows) {
      expect(r.readBy.filter((id) => id === me.id)).toHaveLength(1);
    }
  });

  it('throws NOT_FOUND from markRead for a non-member', async () => {
    const me = await seedUser();
    const other = await seedUser();
    const stranger = await seedUser();
    const convo = await seedConversation([other.id, stranger.id]);

    await expect(markRead(me, convo.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

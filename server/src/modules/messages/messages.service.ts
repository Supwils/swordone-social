import { createHash } from 'node:crypto';
import { and, arrayContains, desc, eq, inArray, not, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { conversations, messages, users } from '../../db/schema';
import { AppError } from '../../lib/errors';
import { type Cursor, buildNextCursor, cursorConditionDesc } from '../../lib/pagination';
import {
  toMessageDTO,
  toConversationDTO,
  type ConversationDTO,
  type ConversationRow,
  type MessageDTO,
  type MessageRow,
  type UserRow,
} from '../../lib/dto';
import { emitToUser, emitToConversation } from '../../realtime/io';
import { createNotification } from '../notifications/notifications.service';

/**
 * Deterministic conversation key: sha256 of the sorted participant ids joined
 * by ':'. Kept in sync across every writer so the `participantKey` unique index
 * collapses a pair to a single conversation regardless of who initiates.
 */
function computeParticipantKey(ids: string[]): string {
  const sorted = ids.map((id) => id.toString()).sort();
  return createHash('sha256').update(sorted.join(':')).digest('hex');
}

/* ---------- conversations ---------- */

export async function findOrCreateWith(
  me: UserRow,
  recipientUsername: string,
): Promise<{ conversation: ConversationRow; created: boolean }> {
  const [recipient] = await db
    .select()
    .from(users)
    .where(and(eq(users.username, recipientUsername.toLowerCase()), eq(users.status, 'active')))
    .limit(1);
  if (!recipient) throw AppError.notFound('User not found');
  if (recipient.id === me.id) {
    throw AppError.validation('Cannot message yourself');
  }

  const participantIds = [me.id, recipient.id];
  const key = computeParticipantKey(participantIds);

  const [existing] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.participantKey, key))
    .limit(1);
  if (existing) return { conversation: existing, created: false };

  const [inserted] = await db
    .insert(conversations)
    .values({ participantIds, participantKey: key, lastMessageAt: new Date() })
    .onConflictDoNothing({ target: conversations.participantKey })
    .returning();
  if (inserted) return { conversation: inserted, created: true };

  // Lost the insert race against a concurrent creator — the row now exists.
  const [raced] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.participantKey, key))
    .limit(1);
  if (!raced) throw AppError.internal('Failed to create conversation');
  return { conversation: raced, created: false };
}

/**
 * `POST /conversations`: find or create the pair's conversation and return it
 * as the viewer's DTO, participants loaded — the route used to query `users`
 * itself. A fresh conversation has no last message.
 */
export async function openConversation(
  me: UserRow,
  recipientUsername: string,
): Promise<{ conversation: ConversationDTO; created: boolean }> {
  const { conversation, created } = await findOrCreateWith(me, recipientUsername);
  const participants = await db
    .select()
    .from(users)
    .where(inArray(users.id, conversation.participantIds));
  return { conversation: toConversationDTO(conversation, participants, me.id, null), created };
}

export async function listForViewer(
  viewer: UserRow,
  cursor: Cursor | null,
  limit: number,
): Promise<{ items: ConversationDTO[]; nextCursor: string | null }> {
  const docs = await db
    .select()
    .from(conversations)
    .where(
      and(
        arrayContains(conversations.participantIds, [viewer.id]),
        cursorConditionDesc(cursor, conversations.lastMessageAt, conversations.id),
      ),
    )
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
    .limit(limit + 1);

  const { items: pageSlice, nextCursor } = buildNextCursor(docs, limit, 'lastMessageAt');

  const participantIds = new Set<string>();
  const lastMessageIds = new Set<string>();
  for (const c of pageSlice) {
    for (const id of c.participantIds) participantIds.add(id);
    if (c.lastMessageId) lastMessageIds.add(c.lastMessageId);
  }

  const [userRows, messageRows] = await Promise.all([
    participantIds.size
      ? db
          .select()
          .from(users)
          .where(inArray(users.id, Array.from(participantIds)))
      : Promise.resolve([] as UserRow[]),
    lastMessageIds.size
      ? db
          .select()
          .from(messages)
          .where(inArray(messages.id, Array.from(lastMessageIds)))
      : Promise.resolve([] as MessageRow[]),
  ]);

  const userById = new Map(userRows.map((u) => [u.id, u]));
  const msgById = new Map(messageRows.map((m) => [m.id, m]));

  const items: ConversationDTO[] = pageSlice.map((c) => {
    const people = c.participantIds
      .map((pid) => userById.get(pid))
      .filter((x): x is UserRow => Boolean(x));
    let lastMessage: MessageDTO | null = null;
    if (c.lastMessageId) {
      const m = msgById.get(c.lastMessageId);
      if (m) {
        const sender = userById.get(m.senderId);
        if (sender) lastMessage = toMessageDTO(m, sender);
      }
    }
    return toConversationDTO(c, people, viewer.id, lastMessage);
  });

  return { items, nextCursor };
}

export async function unreadCount(viewer: UserRow): Promise<number> {
  return db.$count(
    conversations,
    and(
      arrayContains(conversations.participantIds, [viewer.id]),
      arrayContains(conversations.unreadBy, [viewer.id]),
    ),
  );
}

export async function getById(viewer: UserRow, conversationId: string): Promise<ConversationDTO> {
  const convo = await assertMember(viewer, conversationId);
  const participants = convo.participantIds.length
    ? await db.select().from(users).where(inArray(users.id, convo.participantIds))
    : [];
  let lastMessage: MessageDTO | null = null;
  if (convo.lastMessageId) {
    const [msg] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, convo.lastMessageId))
      .limit(1);
    if (msg) {
      const sender = participants.find((u) => u.id === msg.senderId);
      if (sender) lastMessage = toMessageDTO(msg, sender);
    }
  }
  return toConversationDTO(convo, participants, viewer.id, lastMessage);
}

/* ---------- messages ---------- */

export async function listMessages(
  viewer: UserRow,
  conversationId: string,
  cursor: Cursor | null,
  limit: number,
): Promise<{ items: MessageDTO[]; nextCursor: string | null }> {
  const convo = await assertMember(viewer, conversationId);

  const docs = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, convo.id),
        not(arrayContains(messages.deletedFor, [viewer.id])),
        cursorConditionDesc(cursor, messages.createdAt, messages.id),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit + 1);

  const { items, nextCursor } = buildNextCursor(docs, limit);

  const senderIds = Array.from(new Set(items.map((m) => m.senderId)));
  const senders = senderIds.length
    ? await db.select().from(users).where(inArray(users.id, senderIds))
    : [];
  const byId = new Map(senders.map((u) => [u.id, u]));

  const hydrated: MessageDTO[] = items
    .map((m) => {
      const s = byId.get(m.senderId);
      return s ? toMessageDTO(m, s) : null;
    })
    .filter((x): x is MessageDTO => x !== null);

  return { items: hydrated, nextCursor };
}

export async function send(
  sender: UserRow,
  conversationId: string,
  text: string,
): Promise<MessageDTO> {
  const convo = await assertMember(sender, conversationId);

  const otherIds = convo.participantIds.filter((id) => id !== sender.id);

  // Atomic $addToSet equivalent: union the persisted unreadBy with otherIds.
  // Build a proper `ARRAY[$1, $2, …]::text[]` literal — interpolating the raw
  // JS array as `${otherIds}::text[]` binds a scalar param and fails at runtime.
  const otherIdsSql = sql`ARRAY[${sql.join(
    otherIds.map((id) => sql`${id}`),
    sql`, `,
  )}]::text[]`;

  // The message row and the conversation's pointer to it are one unit. Split
  // apart, a failure on the second statement leaves a message that exists but
  // is invisible in the inbox: the conversation still points at the previous
  // lastMessageId, sorts by the old lastMessageAt, and never marks the
  // recipients unread. Emitting realtime events stays outside the transaction.
  const message = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(messages)
      .values({
        conversationId: convo.id,
        senderId: sender.id,
        text,
        readBy: [sender.id],
      })
      .returning();

    await tx
      .update(conversations)
      .set({
        lastMessageId: created.id,
        lastMessageAt: created.createdAt,
        unreadBy: sql`ARRAY(SELECT DISTINCT unnest(${conversations.unreadBy} || ${otherIdsSql}))`,
      })
      .where(eq(conversations.id, convo.id));

    return created;
  });

  const dto = toMessageDTO(message, sender);
  emitToConversation(convo.id, 'message', dto);
  // Notify each other participant individually (their `user:<id>` room) for
  // inbox badges and toasts when they're not currently in the thread.
  for (const otherId of otherIds) {
    emitToUser(otherId, 'conversation:update', { conversationId: convo.id });
    await createNotification({
      recipientId: otherId,
      actorId: sender.id,
      type: 'message',
      messageId: message.id,
      conversationId: convo.id,
    });
  }
  return dto;
}

export async function markRead(viewer: UserRow, conversationId: string): Promise<void> {
  const convo = await assertMember(viewer, conversationId);

  // Both halves of "read" move together. Run concurrently they can half-apply:
  // the conversation drops out of the unread list while individual messages
  // still report unread (or the reverse), and the two views disagree until the
  // next markRead happens to succeed. Sequential inside a transaction costs one
  // extra round-trip and removes the split state.
  await db.transaction(async (tx) => {
    await tx
      .update(conversations)
      .set({ unreadBy: sql`array_remove(${conversations.unreadBy}, ${viewer.id})` })
      .where(eq(conversations.id, convo.id));

    await tx
      .update(messages)
      .set({ readBy: sql`array_append(${messages.readBy}, ${viewer.id})` })
      .where(
        and(
          eq(messages.conversationId, convo.id),
          not(arrayContains(messages.readBy, [viewer.id])),
        ),
      );
  });

  emitToConversation(convo.id, 'message:read', {
    conversationId: convo.id,
    userId: viewer.id,
    at: new Date().toISOString(),
  });
}

async function assertMember(viewer: UserRow, conversationId: string): Promise<ConversationRow> {
  const [convo] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!convo || !convo.participantIds.some((id) => id === viewer.id)) {
    throw AppError.notFound('Conversation not found');
  }
  return convo;
}

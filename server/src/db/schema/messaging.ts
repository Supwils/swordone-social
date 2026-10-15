import { pgTable, text, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { newId } from '../../lib/id';
import type { NotificationType } from '../../contract/messaging';

export const conversations = pgTable(
  'conversations',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    participantIds: text('participant_ids').array().notNull().default([]),
    participantKey: text('participant_key').notNull(),
    lastMessageId: text('last_message_id'),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
    unreadBy: text('unread_by').array().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('conversations_pkey_uq').on(t.participantKey),
    index('conversations_participants_gin').using('gin', t.participantIds),
    index('conversations_lastmsg_idx').on(t.lastMessageAt),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    conversationId: text('conversation_id').notNull(),
    senderId: text('sender_id').notNull(),
    text: text('text').notNull(),
    readBy: text('read_by').array().notNull().default([]),
    deletedFor: text('deleted_for').array().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('messages_conv_created_idx').on(t.conversationId, t.createdAt)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    recipientId: text('recipient_id').notNull(),
    actorId: text('actor_id').notNull(),
    type: text('type').$type<NotificationType>().notNull(),
    postId: text('post_id'),
    commentId: text('comment_id'),
    messageId: text('message_id'),
    conversationId: text('conversation_id'),
    read: boolean('read').notNull().default(false),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notifications_recipient_updated_idx').on(t.recipientId, t.updatedAt),
    index('notifications_recipient_read_idx').on(t.recipientId, t.read),
    index('notifications_recipient_read_updated_idx').on(t.recipientId, t.read, t.updatedAt),
    // Covers the 24h dedup lookup in notifications.service.createNotification.
    index('notifications_dedup_idx').on(
      t.recipientId,
      t.actorId,
      t.type,
      t.postId,
      t.commentId,
      t.createdAt,
    ),
  ],
);

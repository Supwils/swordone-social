import {
  pgTable,
  text,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { newId } from '../../lib/id';
import { users } from './social';
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
    // Per-user "delete for me". READ by listMessages (rows a viewer deleted are
    // hidden) but NEVER WRITTEN — there is no delete-for-me endpoint yet, so it
    // is always []. Kept (dropping it is a migration) until that feature lands.
    deletedFor: text('deleted_for').array().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('messages_conv_created_idx').on(t.conversationId, t.createdAt),
    foreignKey({
      name: 'messages_conversation_id_fkey',
      columns: [t.conversationId],
      foreignColumns: [conversations.id],
    }),
    foreignKey({
      name: 'messages_sender_id_fkey',
      columns: [t.senderId],
      foreignColumns: [users.id],
    }),
  ],
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
    // post_id / comment_id / message_id / conversation_id deliberately carry no
    // FK: a notification is a delivery log that may name a soft-deleted target.
    foreignKey({
      name: 'notifications_recipient_id_fkey',
      columns: [t.recipientId],
      foreignColumns: [users.id],
    }),
    foreignKey({
      name: 'notifications_actor_id_fkey',
      columns: [t.actorId],
      foreignColumns: [users.id],
    }),
  ],
);

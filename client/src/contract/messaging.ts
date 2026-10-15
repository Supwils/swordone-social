// GENERATED from server/src/contract by contract:sync — do not edit.
/**
 * Notifications, direct messages and conversations. Dates are ISO strings on
 * the wire.
 */
import { z } from 'zod';
import { UserLiteDTOSchema } from './users';

/** Every notification kind. Stored in a plain text column (no pgEnum). */
export const NOTIFICATION_TYPES = [
  'like',
  'comment',
  'reply',
  'follow',
  'mention',
  'message',
  'echo',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);

/**
 * One notification. `post` / `comment` / `message` are present when the row
 * references one; `createdAt` is the row's last update (a deduplicated
 * notification is bumped rather than repeated).
 */
export const NotificationDTOSchema = z
  .object({
    id: z.string(),
    type: notificationTypeSchema,
    actor: UserLiteDTOSchema,
    post: z.object({ id: z.string(), textPreview: z.string() }).strict().optional(),
    comment: z.object({ id: z.string(), textPreview: z.string() }).strict().optional(),
    message: z.object({ id: z.string(), conversationId: z.string() }).strict().optional(),
    read: z.boolean(),
    createdAt: z.string(),
  })
  .strict();
export type NotificationDTO = z.infer<typeof NotificationDTOSchema>;

export const MessageDTOSchema = z
  .object({
    id: z.string(),
    conversationId: z.string(),
    sender: UserLiteDTOSchema,
    text: z.string(),
    /** Ids of the participants who have read the message. */
    readBy: z.array(z.string()),
    createdAt: z.string(),
  })
  .strict();
export type MessageDTO = z.infer<typeof MessageDTOSchema>;

export const ConversationDTOSchema = z
  .object({
    id: z.string(),
    participants: z.array(UserLiteDTOSchema),
    lastMessage: MessageDTOSchema.nullable(),
    /** Whether the viewer has unread messages here. */
    unread: z.boolean(),
    updatedAt: z.string(),
  })
  .strict();
export type ConversationDTO = z.infer<typeof ConversationDTOSchema>;

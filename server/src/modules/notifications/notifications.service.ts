import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  or,
  type Column,
  type InferSelectModel,
} from 'drizzle-orm';
import { db } from '../../db/client';
import { notifications, users, posts, comments } from '../../db/schema';
import type { NotificationType } from '../../contract/messaging';
import { type Cursor, encodeCursor } from '../../lib/pagination';
import { emitToUser } from '../../realtime/io';
import { logger } from '../../lib/logger';
import type { UserRow } from '../../lib/dto';
import type { NotificationDTO } from '../../contract/messaging';
import type { UserLiteDTO } from '../../contract/users';
import { toUserLiteDTO } from '../../lib/dto';

type NotificationRow = InferSelectModel<typeof notifications>;

const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

interface CreateInput {
  recipientId: string;
  actorId: string;
  type: NotificationType;
  postId?: string | null;
  commentId?: string | null;
  messageId?: string | null;
  conversationId?: string | null;
}

/** Match a nullable ref column: `is null` when the target is null, else `=`. */
function matchNullable(col: Column, value: string | null) {
  return value == null ? isNull(col) : eq(col, value);
}

/**
 * Create a notification with 24h dedup. Within the window, the existing row
 * matching (recipient, actor, type, target) is bumped forward instead of
 * inserting a new one. Fire-and-forget: never throws — notifications are a
 * nice-to-have that shouldn't block the write they react to.
 */
export async function createNotification(input: CreateInput): Promise<void> {
  if (input.recipientId === input.actorId) return; // never self-notify

  const since = new Date(Date.now() - DEDUP_WINDOW_MS);
  const postId = input.postId ?? null;
  const commentId = input.commentId ?? null;
  const messageId = input.messageId ?? null;
  const conversationId = input.conversationId ?? null;

  try {
    const [existing] = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.recipientId, input.recipientId),
          eq(notifications.actorId, input.actorId),
          eq(notifications.type, input.type),
          matchNullable(notifications.postId, postId),
          matchNullable(notifications.commentId, commentId),
          matchNullable(notifications.messageId, messageId),
          matchNullable(notifications.conversationId, conversationId),
          gte(notifications.createdAt, since),
        ),
      )
      .limit(1);

    let doc: NotificationRow | undefined;
    if (existing) {
      [doc] = await db
        .update(notifications)
        .set({ read: false, readAt: null, updatedAt: new Date() })
        .where(eq(notifications.id, existing.id))
        .returning();
    } else {
      [doc] = await db
        .insert(notifications)
        .values({
          recipientId: input.recipientId,
          actorId: input.actorId,
          type: input.type,
          postId,
          commentId,
          messageId,
          conversationId,
          read: false,
          readAt: null,
        })
        .returning();
    }

    if (!doc) return;
    const dto = await hydrateOne(doc);
    if (dto) emitToUser(input.recipientId, 'notification', dto);
  } catch (err) {
    logger.error({ err, input }, 'createNotification failed');
  }
}

export async function list(
  viewer: UserRow,
  cursor: Cursor | null,
  limit: number,
  unreadOnly: boolean,
): Promise<{ items: NotificationDTO[]; nextCursor: string | null }> {
  const conds = [eq(notifications.recipientId, viewer.id)];
  if (cursor) {
    const t = new Date(cursor.t);
    conds.push(
      or(
        lt(notifications.updatedAt, t),
        and(eq(notifications.updatedAt, t), lt(notifications.id, cursor.id)),
      )!,
    );
  }
  if (unreadOnly) conds.push(eq(notifications.read, false));

  const docs = await db
    .select()
    .from(notifications)
    .where(and(...conds))
    .orderBy(desc(notifications.updatedAt), desc(notifications.id))
    .limit(limit + 1);

  const { items, nextCursor } = buildUpdatedCursorPage(docs, limit);
  const hydrated = await hydrateMany(items);
  return { items: hydrated, nextCursor };
}

export async function unreadCount(viewer: UserRow): Promise<number> {
  return db.$count(
    notifications,
    and(eq(notifications.recipientId, viewer.id), eq(notifications.read, false)),
  );
}

export async function clearAll(viewer: UserRow): Promise<void> {
  await db.delete(notifications).where(eq(notifications.recipientId, viewer.id));
  emitToUser(viewer.id, 'notification:read', { ids: 'all' });
}

export async function markRead(viewer: UserRow, ids: string[] | 'all'): Promise<void> {
  if (ids === 'all') {
    await db
      .update(notifications)
      .set({ read: true, readAt: new Date() })
      .where(and(eq(notifications.recipientId, viewer.id), eq(notifications.read, false)));
  } else if (ids.length) {
    await db
      .update(notifications)
      .set({ read: true, readAt: new Date() })
      .where(
        and(
          eq(notifications.recipientId, viewer.id),
          inArray(notifications.id, ids),
          eq(notifications.read, false),
        ),
      );
  }
  emitToUser(viewer.id, 'notification:read', { ids });
}

/* ---------- hydration ---------- */

async function hydrateOne(doc: NotificationRow): Promise<NotificationDTO | null> {
  const [actorRows, postRows, commentRows] = await Promise.all([
    db.select().from(users).where(eq(users.id, doc.actorId)).limit(1),
    doc.postId
      ? db.select({ text: posts.text }).from(posts).where(eq(posts.id, doc.postId)).limit(1)
      : Promise.resolve([] as { text: string }[]),
    doc.commentId
      ? db
          .select({ text: comments.text })
          .from(comments)
          .where(eq(comments.id, doc.commentId))
          .limit(1)
      : Promise.resolve([] as { text: string }[]),
  ]);
  const actor = actorRows[0];
  if (!actor) return null;
  return toNotificationDTO(doc, toUserLiteDTO(actor), postRows[0]?.text, commentRows[0]?.text);
}

async function hydrateMany(docs: NotificationRow[]): Promise<NotificationDTO[]> {
  if (docs.length === 0) return [];

  const actorIds = Array.from(new Set(docs.map((d) => d.actorId)));
  const postIds = Array.from(
    new Set(docs.map((d) => d.postId).filter((x): x is string => Boolean(x))),
  );
  const commentIds = Array.from(
    new Set(docs.map((d) => d.commentId).filter((x): x is string => Boolean(x))),
  );

  const [actors, postRows, commentRows] = await Promise.all([
    actorIds.length
      ? db.select().from(users).where(inArray(users.id, actorIds))
      : Promise.resolve([] as UserRow[]),
    postIds.length
      ? db.select({ id: posts.id, text: posts.text }).from(posts).where(inArray(posts.id, postIds))
      : Promise.resolve([] as { id: string; text: string }[]),
    commentIds.length
      ? db
          .select({ id: comments.id, text: comments.text })
          .from(comments)
          .where(inArray(comments.id, commentIds))
      : Promise.resolve([] as { id: string; text: string }[]),
  ]);

  const actorById = new Map<string, UserLiteDTO>(actors.map((u) => [u.id, toUserLiteDTO(u)]));
  const postById = new Map(postRows.map((p) => [p.id, p.text]));
  const commentById = new Map(commentRows.map((c) => [c.id, c.text]));

  return docs
    .map((d) => {
      const actor = actorById.get(d.actorId);
      if (!actor) return null;
      return toNotificationDTO(
        d,
        actor,
        d.postId ? postById.get(d.postId) : undefined,
        d.commentId ? commentById.get(d.commentId) : undefined,
      );
    })
    .filter((x): x is NotificationDTO => x !== null);
}

export function toNotificationDTO(
  doc: NotificationRow,
  actor: UserLiteDTO,
  postText?: string,
  commentText?: string,
): NotificationDTO {
  return {
    id: doc.id,
    type: doc.type,
    actor,
    post: doc.postId ? { id: doc.postId, textPreview: preview(postText) } : undefined,
    comment: doc.commentId ? { id: doc.commentId, textPreview: preview(commentText) } : undefined,
    message:
      doc.messageId && doc.conversationId
        ? { id: doc.messageId, conversationId: doc.conversationId }
        : undefined,
    read: doc.read,
    createdAt: doc.updatedAt.toISOString(),
  };
}

function preview(text: string | undefined): string {
  if (!text) return '';
  return text.length > 80 ? `${text.slice(0, 80).trimEnd()}…` : text;
}

export function buildUpdatedCursorPage(
  docs: NotificationRow[],
  limit: number,
): { items: NotificationRow[]; nextCursor: string | null } {
  if (docs.length <= limit) {
    return { items: docs, nextCursor: null };
  }
  const page = docs.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: encodeCursor({ t: last.updatedAt.toISOString(), id: last.id }),
  };
}

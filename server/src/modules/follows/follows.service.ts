import { and, or, eq, desc, inArray, ilike, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { escapeLike } from '../../lib/sql';
import { follows, users } from '../../db/schema';
import { AppError } from '../../lib/errors';
import { type Cursor, buildNextCursor, cursorConditionDesc } from '../../lib/pagination';
import type { UserLiteDTO, UserRow } from '../../lib/dto';
import { toUserLiteDTO } from '../../lib/dto';
import { createNotification } from '../notifications/notifications.service';

async function findUserByUsername(username: string): Promise<UserRow> {
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.username, username.toLowerCase()), eq(users.status, 'active')))
    .limit(1);
  if (!user) throw AppError.notFound('User not found');
  return user;
}

export async function follow(follower: UserRow, targetUsername: string): Promise<void> {
  const target = await findUserByUsername(targetUsername);
  if (target.id === follower.id) {
    throw AppError.validation('Cannot follow yourself');
  }

  // Insert the edge and bump both counters atomically. An existing edge is a
  // no-op insert (onConflictDoNothing) that we surface as a conflict.
  await db.transaction(async (tx) => {
    const [edge] = await tx
      .insert(follows)
      .values({ followerId: follower.id, followingId: target.id })
      .onConflictDoNothing()
      .returning({ id: follows.id });
    if (!edge) throw AppError.conflict('Already following this user');

    await tx
      .update(users)
      .set({ followingCount: sql`${users.followingCount} + 1` })
      .where(eq(users.id, follower.id));
    await tx
      .update(users)
      .set({ followerCount: sql`${users.followerCount} + 1` })
      .where(eq(users.id, target.id));
  });

  await createNotification({
    recipientId: target.id,
    actorId: follower.id,
    type: 'follow',
  });
}

export async function unfollow(follower: UserRow, targetUsername: string): Promise<void> {
  const target = await findUserByUsername(targetUsername);
  if (target.id === follower.id) return;

  await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(follows)
      .where(and(eq(follows.followerId, follower.id), eq(follows.followingId, target.id)))
      .returning({ id: follows.id });
    if (deleted.length === 0) return;

    await tx
      .update(users)
      .set({ followingCount: sql`${users.followingCount} - 1` })
      .where(eq(users.id, follower.id));
    await tx
      .update(users)
      .set({ followerCount: sql`${users.followerCount} - 1` })
      .where(eq(users.id, target.id));
  });
}

type Direction = 'following' | 'followers';

async function listEdges(
  username: string,
  direction: Direction,
  cursor: Cursor | null,
  limit: number,
  search?: string,
): Promise<{ items: UserLiteDTO[]; nextCursor: string | null }> {
  const user = await findUserByUsername(username);

  // Following → this user is the follower; followers → this user is the followed.
  const baseEdgeCond =
    direction === 'following' ? eq(follows.followerId, user.id) : eq(follows.followingId, user.id);
  const peerCol = direction === 'following' ? follows.followingId : follows.followerId;

  const term = search?.trim();
  if (term) {
    // Search mode: get all peer IDs (capped at 2000) then match on User.
    const allEdges = await db
      .select({ peerId: peerCol })
      .from(follows)
      .where(baseEdgeCond)
      .limit(2000);

    const peerIds = allEdges.map((e) => e.peerId);
    if (!peerIds.length) return { items: [], nextCursor: null };

    const pattern = `%${escapeLike(term)}%`;
    const peerUsers = await db
      .select()
      .from(users)
      .where(
        and(
          inArray(users.id, peerIds),
          eq(users.status, 'active'),
          or(ilike(users.username, pattern), ilike(users.displayName, pattern)),
        ),
      )
      .limit(50);

    return { items: peerUsers.map(toUserLiteDTO), nextCursor: null };
  }

  // Descending by createdAt, id breaking ties — cursor points at the last row
  // of the previous page; fetch rows strictly older.
  const edges = await db
    .select({ id: follows.id, createdAt: follows.createdAt, peerId: peerCol })
    .from(follows)
    .where(and(baseEdgeCond, cursorConditionDesc(cursor, follows.createdAt, follows.id)))
    .orderBy(desc(follows.createdAt), desc(follows.id))
    .limit(limit + 1);
  const { items: page, nextCursor } = buildNextCursor(edges, limit);

  const peerIds = page.map((e) => e.peerId);
  const peerUsers = peerIds.length
    ? await db
        .select()
        .from(users)
        .where(and(inArray(users.id, peerIds), eq(users.status, 'active')))
    : [];
  const byId = new Map(peerUsers.map((u) => [u.id, u]));

  const ordered: UserLiteDTO[] = page
    .map((e) => {
      const u = byId.get(e.peerId);
      return u ? toUserLiteDTO(u) : null;
    })
    .filter((x): x is UserLiteDTO => x !== null);

  return { items: ordered, nextCursor };
}

export const listFollowing = (u: string, c: Cursor | null, l: number, search?: string) =>
  listEdges(u, 'following', c, l, search);
export const listFollowers = (u: string, c: Cursor | null, l: number, search?: string) =>
  listEdges(u, 'followers', c, l, search);

export async function isFollowing(follower: UserRow, targetUsername: string): Promise<boolean> {
  const target = await findUserByUsername(targetUsername);
  const [hit] = await db
    .select({ id: follows.id })
    .from(follows)
    .where(and(eq(follows.followerId, follower.id), eq(follows.followingId, target.id)))
    .limit(1);
  return Boolean(hit);
}

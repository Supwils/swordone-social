import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import {
  apiKeys,
  boards,
  bookmarks,
  comments,
  conversations,
  follows,
  likes,
  messages,
  notifications,
  posts,
  users,
} from '../db/schema';
import { newId } from '../lib/id';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Run `fn` in a transaction with foreign-key triggers off, so a test can write
 * the historical orphans production still holds (0006 added its constraints
 * NOT VALID). `session_replication_role = replica` skips the RI triggers and
 * needs a superuser — the local brew role and CI's `postgres` both are.
 * `SET LOCAL` ends with the transaction; the rows it wrote stay.
 */
export async function withForeignKeysOff<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    return fn(tx);
  });
}

/** An id no row has. */
export const MISSING_ID = 'f'.repeat(24);

/** Real ids for every parent table of a 0006 constraint, keyed by table name. */
export interface FkParents {
  users: string;
  posts: string;
  comments: string;
  boards: string;
  conversations: string;
}

let seq = 0;
export function fkUserValues(
  over: Partial<typeof users.$inferInsert> = {},
): typeof users.$inferInsert {
  seq += 1;
  const name = `fk${seq}_${newId().slice(-6)}`;
  return { username: name, usernameDisplay: name, email: `${name}@example.test`, ...over };
}

export async function seedFkParents(): Promise<FkParents> {
  const [u] = await db.insert(users).values(fkUserValues()).returning();
  const [b] = await db
    .insert(boards)
    .values({ slug: `b-${newId()}`, name: 'Board' })
    .returning();
  const [p] = await db.insert(posts).values({ authorId: u.id, text: 'parent' }).returning();
  const [c] = await db
    .insert(comments)
    .values({ postId: p.id, authorId: u.id, text: 'parent' })
    .returning();
  const [conv] = await db
    .insert(conversations)
    .values({ participantIds: [u.id], participantKey: `k-${newId()}` })
    .returning();
  return { users: u.id, posts: p.id, comments: c.id, boards: b.id, conversations: conv.id };
}

/** Exactly one orphan for each of the 17 constraints of 0006. */
export async function seedOneOrphanPerConstraint(p: FkParents): Promise<void> {
  const m = MISSING_ID;
  await withForeignKeysOff(async (tx) => {
    await tx.insert(users).values(fkUserValues({ ownerId: m }));
    await tx.insert(apiKeys).values({ userId: m, name: 'k', keyHash: newId() });
    await tx
      .insert(posts)
      .values([
        { authorId: m },
        { authorId: p.users, boardId: m },
        { authorId: p.users, echoOf: m },
      ]);
    await tx.insert(comments).values([
      { postId: m, authorId: p.users, text: 'c' },
      { postId: p.posts, authorId: m, text: 'c' },
      { postId: p.posts, authorId: p.users, parentId: m, text: 'c' },
    ]);
    await tx.insert(likes).values({ userId: m, targetType: 'post', targetId: p.posts });
    await tx.insert(follows).values([
      { followerId: m, followingId: p.users },
      { followerId: p.users, followingId: m },
    ]);
    await tx.insert(bookmarks).values([
      { userId: m, postId: p.posts },
      { userId: p.users, postId: m },
    ]);
    await tx.insert(messages).values([
      { conversationId: m, senderId: p.users, text: 'm' },
      { conversationId: p.conversations, senderId: m, text: 'm' },
    ]);
    await tx.insert(notifications).values([
      { recipientId: m, actorId: p.users, type: 'follow' },
      { recipientId: p.users, actorId: m, type: 'follow' },
    ]);
  });
}

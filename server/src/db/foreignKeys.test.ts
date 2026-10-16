import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from './client';
import {
  apiKeys,
  bookmarks,
  comments,
  follows,
  likes,
  messages,
  notifications,
  posts,
  users,
} from './schema';
import {
  FOREIGN_KEYS,
  formatStatus,
  inspectForeignKeys,
  orphanCountSql,
  type SqlRunner,
} from './foreignKeys';
import { APP_TABLE_NAMES, truncateStatement } from './tables';
import { newId } from '../lib/id';
import { resetDb } from '../test/db-reset';
import {
  MISSING_ID as MISSING,
  fkUserValues as userValues,
  seedFkParents as seedParents,
  seedOneOrphanPerConstraint,
  type FkParents as Parents,
} from '../test/orphans';

/**
 * Migration 0006 against the real test database: the constraint set matches the
 * schema, every child write naming a missing parent is rejected, and the
 * orphan inspection never writes. Review Focus 1 and 2.
 */

const MIGRATION = readFileSync(
  join(__dirname, 'migrations', '0006_platform_foreign_keys.sql'),
  'utf8',
);

/** The spec §4 table plus `posts.echo_of` (§10.4). */
const EXPECTED = [
  'api_keys_user_id_fkey',
  'bookmarks_post_id_fkey',
  'bookmarks_user_id_fkey',
  'comments_author_id_fkey',
  'comments_parent_id_fkey',
  'comments_post_id_fkey',
  'follows_follower_id_fkey',
  'follows_following_id_fkey',
  'likes_user_id_fkey',
  'messages_conversation_id_fkey',
  'messages_sender_id_fkey',
  'notifications_actor_id_fkey',
  'notifications_recipient_id_fkey',
  'posts_author_id_fkey',
  'posts_board_id_fkey',
  'posts_echo_of_fkey',
  'users_owner_id_fkey',
];

/** One child insert per constraint; `ref` goes in the FK column, every other id is real. */
const CHILD_INSERTS: Record<string, (p: Parents, ref: string) => Promise<unknown>> = {
  users_owner_id_fkey: (_p, ref) => db.insert(users).values(userValues({ ownerId: ref })),
  api_keys_user_id_fkey: (_p, ref) =>
    db.insert(apiKeys).values({ userId: ref, name: 'k', keyHash: newId() }),
  posts_author_id_fkey: (_p, ref) => db.insert(posts).values({ authorId: ref }),
  posts_board_id_fkey: (p, ref) => db.insert(posts).values({ authorId: p.users, boardId: ref }),
  posts_echo_of_fkey: (p, ref) => db.insert(posts).values({ authorId: p.users, echoOf: ref }),
  comments_post_id_fkey: (p, ref) =>
    db.insert(comments).values({ postId: ref, authorId: p.users, text: 'c' }),
  comments_author_id_fkey: (p, ref) =>
    db.insert(comments).values({ postId: p.posts, authorId: ref, text: 'c' }),
  comments_parent_id_fkey: (p, ref) =>
    db.insert(comments).values({ postId: p.posts, authorId: p.users, parentId: ref, text: 'c' }),
  likes_user_id_fkey: (p, ref) =>
    db.insert(likes).values({ userId: ref, targetType: 'post', targetId: p.posts }),
  follows_follower_id_fkey: async (_p, ref) => {
    const [other] = await db.insert(users).values(userValues()).returning();
    return db.insert(follows).values({ followerId: ref, followingId: other.id });
  },
  follows_following_id_fkey: (p, ref) =>
    db.insert(follows).values({ followerId: p.users, followingId: ref }),
  bookmarks_user_id_fkey: (p, ref) => db.insert(bookmarks).values({ userId: ref, postId: p.posts }),
  bookmarks_post_id_fkey: (p, ref) => db.insert(bookmarks).values({ userId: p.users, postId: ref }),
  messages_conversation_id_fkey: (p, ref) =>
    db.insert(messages).values({ conversationId: ref, senderId: p.users, text: 'm' }),
  messages_sender_id_fkey: (p, ref) =>
    db.insert(messages).values({ conversationId: p.conversations, senderId: ref, text: 'm' }),
  notifications_recipient_id_fkey: (p, ref) =>
    db.insert(notifications).values({ recipientId: ref, actorId: p.users, type: 'follow' }),
  notifications_actor_id_fkey: (p, ref) =>
    db.insert(notifications).values({ recipientId: p.users, actorId: ref, type: 'follow' }),
};

/** drizzle wraps the pg error; walk `.cause` to the DatabaseError. */
function pgError(err: unknown): { code?: string; constraint?: string } {
  let e: unknown = err;
  while (e && typeof e === 'object') {
    const o = e as { code?: string; constraint?: string; cause?: unknown };
    if (o.code) return o;
    e = o.cause;
  }
  return {};
}

describe('0006 platform foreign keys', () => {
  beforeEach(resetDb);

  it('declares exactly the spec §4 constraints, all single-column, in the schema', () => {
    expect(FOREIGN_KEYS.map((fk) => fk.name)).toEqual(EXPECTED);
    for (const fk of FOREIGN_KEYS) {
      expect(fk.name).toBe(`${fk.table}_${fk.column}_fkey`);
      expect(fk.parentColumn).toBe('id');
    }
  });

  it('created the same constraints in the database, NO ACTION, NOT VALID', async () => {
    const { rows } = await pool.query<{
      conname: string;
      child: string;
      col: string;
      parent: string;
      pcol: string;
      confdeltype: string;
      convalidated: boolean;
    }>(`
      SELECT c.conname, cl.relname AS child, a.attname AS col, pcl.relname AS parent,
             pa.attname AS pcol, c.confdeltype, c.convalidated
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_class pcl ON pcl.oid = c.confrelid
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
      ORDER BY c.conname`);
    expect(
      rows.map((r) => ({
        name: r.conname,
        table: r.child,
        column: r.col,
        parentTable: r.parent,
        parentColumn: r.pcol,
      })),
    ).toEqual(FOREIGN_KEYS);
    // 'a' = NO ACTION. The validate-script test restores NOT VALID when it is done.
    expect(new Set(rows.map((r) => r.confdeltype))).toEqual(new Set(['a']));
    expect(rows.every((r) => r.convalidated === false)).toBe(true);
  });

  it('adds every constraint NOT VALID and documents a rollback for each', () => {
    const adds = MIGRATION.match(/ADD CONSTRAINT "\w+"[^;]*;/g) ?? [];
    expect(adds).toHaveLength(EXPECTED.length);
    for (const a of adds) expect(a).toMatch(/ON DELETE no action ON UPDATE no action NOT VALID;$/);
    const drops = [...MIGRATION.matchAll(/^-- {3}ALTER TABLE "\w+" DROP CONSTRAINT "(\w+)";$/gm)];
    expect(drops.map((m) => m[1]).sort()).toEqual(EXPECTED);
  });

  it('has a child insert for every constraint', () => {
    expect(Object.keys(CHILD_INSERTS).sort()).toEqual(EXPECTED);
  });

  it.each(EXPECTED)('%s rejects a child whose parent is missing', async (name) => {
    const fk = FOREIGN_KEYS.find((f) => f.name === name)!;
    const parents = await seedParents();
    const insert = CHILD_INSERTS[name];

    const err = await insert(parents, MISSING).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    expect(pgError(err)).toMatchObject({ code: '23503', constraint: name });

    // Control: the same insert with the real parent goes through.
    await expect(insert(parents, parents[fk.parentTable as keyof Parents])).resolves.toBeDefined();
  });

  it('refuses to hard-delete a parent that still has children (NO ACTION)', async () => {
    const p = await seedParents();
    const err = await db
      .delete(users)
      .where(sql`${users.id} = ${p.users}`)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(pgError(err).code).toBe('23503');
  });
});

describe('inspectForeignKeys', () => {
  beforeEach(resetDb);

  /** Records every statement the inspection sends over one real client. */
  async function recorded<T>(
    fn: (r: SqlRunner) => Promise<T>,
  ): Promise<{ out: T; sent: string[] }> {
    const client = await pool.connect();
    const sent: string[] = [];
    try {
      const runner: SqlRunner = {
        query: (text) => {
          sent.push(text);
          return client.query(text);
        },
      };
      return { out: await fn(runner), sent };
    } finally {
      client.release();
    }
  }

  it('counts one orphan per constraint, written with FK triggers off', async () => {
    const p = await seedParents();
    await seedOneOrphanPerConstraint(p);

    const { out } = await recorded(inspectForeignKeys);
    expect(Object.fromEntries(out.map((s) => [s.fk.name, s.orphans]))).toEqual(
      Object.fromEntries(EXPECTED.map((n) => [n, 1])),
    );
    expect(out.every((s) => s.present && !s.validated)).toBe(true);
    expect(formatStatus(out[0])).toMatch(/api_keys_user_id_fkey\s+1 orphan\(s\)\s+\[not valid\]/);
  });

  it('ignores NULL in nullable FK columns and reports a clean database as zero', async () => {
    const p = await seedParents();
    await db.insert(posts).values({ authorId: p.users, boardId: null, echoOf: null });
    const { out } = await recorded(inspectForeignKeys);
    expect(out.every((s) => s.orphans === 0)).toBe(true);
  });

  it('runs in a READ ONLY transaction it rolls back, sending only reads', async () => {
    const { sent } = await recorded(inspectForeignKeys);
    expect(sent[0]).toBe('BEGIN READ ONLY');
    expect(sent[1]).toBe('SHOW transaction_read_only');
    expect(sent.at(-1)).toBe('ROLLBACK');
    for (const s of sent.slice(2, -1)) expect(s).toMatch(/^SELECT /);
    expect(sent.slice(2, -1)).toHaveLength(EXPECTED.length + 1);
  });

  it('a write inside its transaction would be refused by the database', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await expect(client.query(`DELETE FROM "users"`)).rejects.toMatchObject({ code: '25006' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('refuses to continue when the transaction is not read-only', async () => {
    const runner: SqlRunner = {
      query: async (text) =>
        text === 'SHOW transaction_read_only'
          ? { rows: [{ transaction_read_only: 'off' }] }
          : { rows: [] },
    };
    await expect(inspectForeignKeys(runner)).rejects.toThrow(/not read-only/);
  });

  it('builds a NULL-tolerant NOT EXISTS count', () => {
    const fk = FOREIGN_KEYS.find((f) => f.name === 'posts_board_id_fkey')!;
    expect(orphanCountSql(fk)).toBe(
      'SELECT count(*)::int AS n FROM "posts" c WHERE c."board_id" IS NOT NULL ' +
        'AND NOT EXISTS (SELECT 1 FROM "boards" p WHERE p."id" = c."board_id")',
    );
  });
});

describe('truncateStatement', () => {
  it('covers every table in the public schema', async () => {
    const { rows } = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    expect([...APP_TABLE_NAMES]).toEqual(rows.map((r) => r.tablename).sort());
  });

  it('clears parents and children in one statement under the foreign keys', async () => {
    const p = await seedParents();
    await db.insert(bookmarks).values({ userId: p.users, postId: p.posts });
    await db.execute(sql.raw(truncateStatement(['session'])));
    expect(await db.$count(users)).toBe(0);
    expect(await db.$count(bookmarks)).toBe(0);
  });

  it('keeps excluded tables out and refuses an empty list', () => {
    expect(truncateStatement(['session'])).not.toContain('"session"');
    expect(truncateStatement()).toMatch(/^TRUNCATE .* RESTART IDENTITY CASCADE$/);
    expect(() => truncateStatement([...APP_TABLE_NAMES])).toThrow(/no tables/);
  });
});

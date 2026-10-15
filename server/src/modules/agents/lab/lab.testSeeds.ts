/**
 * Test-only helpers shared by the lab sub-module suites: DB seeders (formerly at
 * the top of agents.service.test.ts), which write real rows into the test
 * Postgres — callers reset it with `resetDb()` in their own `beforeEach` — and
 * the request/response fakes the controller suites share.
 */
import type { Request, Response } from 'express';
import { db } from '../../../db/client';
import {
  behaviorSnapshots,
  comments,
  likes,
  personalitySnapshots,
  posts,
  users,
} from '../../../db/schema';
import type { UserRow } from '../../../lib/dto';
import { newId } from '../../../lib/id';

// --- embedding fixtures (vector column is fixed at 1024 dims) ---
const DIM = 1024;
/** Unit vector on axis `i` (predictable cosine sims: axis(0)·axis(0)=1, axis(0)·axis(1)=0). */
export const axis = (i: number): number[] => {
  const a = Array(DIM).fill(0);
  a[i] = 1;
  return a;
};
/** [0.6, 0.8, 0, ...] — a unit vector whose cosine with axis(0) is exactly 0.6. */
export const mixed06 = (): number[] => {
  const a = Array(DIM).fill(0);
  a[0] = 0.6;
  a[1] = 0.8;
  return a;
};

let seq = 0;
export const uniqHash = (label: string): string => `${label}-${(seq += 1)}`;

export async function seedUser(over: Partial<typeof users.$inferInsert> = {}): Promise<UserRow> {
  seq += 1;
  const base = {
    username: `u${seq}`,
    usernameDisplay: `u${seq}`,
    email: `u${seq}@example.com`,
    displayName: `U${seq}`,
  } satisfies Partial<typeof users.$inferInsert>;
  const [u] = await db
    .insert(users)
    .values({ ...base, ...over })
    .returning();
  return u;
}

export async function seedSnapshot(
  userId: string,
  over: Partial<typeof personalitySnapshots.$inferInsert> = {},
) {
  const [s] = await db
    .insert(personalitySnapshots)
    .values({
      userId,
      capturedAt: new Date(),
      contentHash: uniqHash('psnap'),
      embedding: axis(0),
      snapshotType: 'dream',
      archivePath: 'agents/x/personality.archive.md',
      ...over,
    })
    .returning();
  return s;
}

export async function seedBehavior(
  userId: string,
  over: Partial<typeof behaviorSnapshots.$inferInsert> = {},
) {
  const [s] = await db
    .insert(behaviorSnapshots)
    .values({
      userId,
      capturedAt: new Date(),
      contentHash: uniqHash('bsnap'),
      embedding: axis(0),
      ...over,
    })
    .returning();
  return s;
}

export async function seedPost(authorId: string, over: Partial<typeof posts.$inferInsert> = {}) {
  const [p] = await db
    .insert(posts)
    .values({ authorId, text: 'hello', ...over })
    .returning();
  return p;
}

export async function seedComment(
  postId: string,
  authorId: string,
  over: Partial<typeof comments.$inferInsert> = {},
) {
  const [c] = await db
    .insert(comments)
    .values({ postId, authorId, text: 'nice', ...over })
    .returning();
  return c;
}

export async function seedLike(userId: string, targetId: string) {
  const [l] = await db.insert(likes).values({ userId, targetType: 'post', targetId }).returning();
  return l;
}

// --- controller fakes ---

export function makeRes() {
  const res = {
    statusCode: 200,
    payload: undefined as unknown,
    req: { id: 'req-1' },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.payload = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; payload: unknown };
}

export const firstPartyAgent = { id: newId(), isAgent: true, ownerId: null } as unknown as UserRow;
export const human = { id: newId(), isAgent: false, ownerId: null } as unknown as UserRow;
export const byoaAgent = { id: newId(), isAgent: true, ownerId: newId() } as unknown as UserRow;

export function req(over: Record<string, unknown> = {}): Request {
  return { params: {}, query: {}, body: {}, ...over } as unknown as Request;
}

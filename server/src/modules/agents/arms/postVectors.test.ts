import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHash, randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import { createApp } from '../../../app';
import { db } from '../../../db/client';
import { agentEvents, apiKeys, posts, postVectors, users } from '../../../db/schema';
import { resetDb } from '../../../test/db-reset';
import { ingestPostVector } from './postVectors';
import { postVectorIngest } from './arms.schemas';

/**
 * Review Focus 3: the act path files a post's vector with its round id, and a
 * later backfill replays the same post with `roundId: null`. The replay must be
 * a 200 carrying the SAME id (the agent counts a vector as filed only on a 2xx
 * with `data.id`), and the row must not move to another round.
 */

const HOUR = 60 * 60 * 1000;
const ROUND = '20261014T060000Z-r';
const OTHER_ROUND = '20261016T060000Z-r';

const vec = (n = 1024) => Array.from({ length: n }, (_, i) => (i % 7) / 7);

async function seedUser(over: Partial<typeof users.$inferInsert> = {}) {
  const username = over.username ?? `pv${Math.random().toString(16).slice(2, 8)}`;
  const [user] = await db
    .insert(users)
    .values({
      username,
      usernameDisplay: username,
      email: `${username}@example.test`,
      displayName: username,
      isAgent: true,
      ...over,
    })
    .returning();
  const key = `sk-swil-${randomBytes(8).toString('hex')}`;
  await db.insert(apiKeys).values({
    userId: user.id,
    name: 'test',
    keyHash: createHash('sha256').update(key).digest('hex'),
  });
  return { user, key };
}

async function seedPost(authorId: string, createdAt = new Date()): Promise<string> {
  const [p] = await db
    .insert(posts)
    .values({ authorId, text: 'a post', createdAt })
    .returning({ id: posts.id });
  return p.id;
}

async function seedEcho(authorId: string, originalId: string): Promise<string> {
  const [p] = await db
    .insert(posts)
    .values({ authorId, text: '', echoOf: originalId })
    .returning({ id: posts.id });
  return p.id;
}

async function seedCycleCard(userId: string, createdAt: Date, roundId: string): Promise<void> {
  await db.insert(agentEvents).values({
    userId,
    type: 'cycle',
    phase: 'act',
    outcome: 'success',
    summary: 'cycle_run',
    metrics: { kind: 'cycle_run', roundId },
    createdAt,
  });
}

const body = (postId: string, over: Record<string, unknown> = {}) => ({
  postId,
  roundId: ROUND,
  embedding: vec(),
  cardSim: 0.71,
  maxSim: 0.42,
  ...over,
});

beforeEach(async () => {
  await resetDb();
});

describe('postVectorIngest schema', () => {
  it('accepts the wire contract the agent speaks', () => {
    expect(postVectorIngest.safeParse(body('p1')).success).toBe(true);
    expect(
      postVectorIngest.safeParse(body('p1', { roundId: null, cardSim: null, maxSim: null }))
        .success,
    ).toBe(true);
    expect(postVectorIngest.safeParse(body('p1', { roundId: '20261014T060000Z-m' })).success).toBe(
      true,
    );
  });

  it.each([
    ['a 1023-dim vector', { embedding: vec(1023) }],
    ['a 1025-dim vector', { embedding: vec(1025) }],
    ['a malformed round id', { roundId: '2026-10-14-r' }],
    ['an unknown round kind', { roundId: '20261014T060000Z-x' }],
    ['cardSim above 1', { cardSim: 1.01 }],
    ['maxSim below -1', { maxSim: -1.5 }],
    ['an empty postId', { postId: '' }],
    ['a postId over 64 chars', { postId: 'x'.repeat(65) }],
  ])('rejects %s', (_label, over) => {
    expect(postVectorIngest.safeParse(body('p1', over)).success).toBe(false);
  });
});

describe('ingestPostVector', () => {
  it('creates a row and tags it as act when the round is known', async () => {
    const { user } = await seedUser();
    const postId = await seedPost(user.id);

    const out = await ingestPostVector(user, user.username, body(postId));

    expect(out.created).toBe(true);
    const [row] = await db.select().from(postVectors).where(eq(postVectors.id, out.id));
    expect(row).toMatchObject({
      postId,
      userId: user.id,
      roundId: ROUND,
      cardSim: 0.71,
      maxSim: 0.42,
      source: 'act',
    });
    expect(row.embedding).toHaveLength(1024);
  });

  it('replays with the same round → same id, not created', async () => {
    const { user } = await seedUser();
    const postId = await seedPost(user.id);
    const first = await ingestPostVector(user, user.username, body(postId));

    const again = await ingestPostVector(user, user.username, body(postId));

    expect(again).toEqual({ id: first.id, created: false });
  });

  it('replays with a null round (backfill after act) → same id, row unchanged', async () => {
    const { user } = await seedUser();
    const postId = await seedPost(user.id);
    const first = await ingestPostVector(user, user.username, body(postId));

    const again = await ingestPostVector(
      user,
      user.username,
      body(postId, { roundId: null, cardSim: 0.1 }),
    );

    expect(again).toEqual({ id: first.id, created: false });
    const [row] = await db.select().from(postVectors).where(eq(postVectors.id, first.id));
    expect(row.roundId).toBe(ROUND);
    expect(row.cardSim).toBe(0.71);
    expect(row.source).toBe('act');
  });

  it('accepts a known round onto a stored null round without rewriting it', async () => {
    const { user } = await seedUser();
    const postId = await seedPost(user.id);
    const first = await ingestPostVector(user, user.username, body(postId, { roundId: null }));

    const again = await ingestPostVector(user, user.username, body(postId));

    expect(again).toEqual({ id: first.id, created: false });
    const [row] = await db.select().from(postVectors).where(eq(postVectors.id, first.id));
    expect(row.roundId).toBeNull();
  });

  it('files one row when the same post arrives concurrently', async () => {
    const { user } = await seedUser();
    const postId = await seedPost(user.id);

    const outs = await Promise.all(
      Array.from({ length: 5 }, () => ingestPostVector(user, user.username, body(postId))),
    );

    expect(new Set(outs.map((o) => o.id)).size).toBe(1);
    expect(outs.filter((o) => o.created)).toHaveLength(1);
    const rows = await db.select().from(postVectors).where(eq(postVectors.postId, postId));
    expect(rows).toHaveLength(1);
  });

  it('rejects a different non-null round with 409', async () => {
    const { user } = await seedUser();
    const postId = await seedPost(user.id);
    await ingestPostVector(user, user.username, body(postId));

    await expect(
      ingestPostVector(user, user.username, body(postId, { roundId: OTHER_ROUND })),
    ).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
  });

  it("rejects filing a vector for someone else's post with 403", async () => {
    const { user } = await seedUser();
    const { user: other } = await seedUser();
    const postId = await seedPost(other.id);

    await expect(ingestPostVector(user, user.username, body(postId))).rejects.toMatchObject({
      status: 403,
    });
  });

  it("rejects writing under another account's username with 403", async () => {
    const { user } = await seedUser();
    const { user: other } = await seedUser();
    const postId = await seedPost(other.id);

    await expect(ingestPostVector(user, other.username, body(postId))).rejects.toMatchObject({
      status: 403,
    });
  });

  it('404s an unknown post', async () => {
    const { user } = await seedUser();
    await expect(ingestPostVector(user, user.username, body('nope'))).rejects.toMatchObject({
      status: 404,
    });
  });

  it('refuses an echo with 400 VALIDATION_ERROR and files nothing (an echo is not a post)', async () => {
    const { user } = await seedUser();
    const { user: other } = await seedUser();
    const original = await seedPost(other.id);
    const echoId = await seedEcho(user.id, original);

    await expect(ingestPostVector(user, user.username, body(echoId))).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      fields: { postId: 'ECHO' },
    });
    await expect(
      ingestPostVector(user, user.username, body(echoId, { roundId: null })),
    ).rejects.toMatchObject({ status: 400 });
    const rows = await db.select().from(postVectors).where(eq(postVectors.postId, echoId));
    expect(rows).toHaveLength(0);
  });

  it('accepts a post in any status (a deleted post was still a candidate)', async () => {
    const { user } = await seedUser();
    const postId = await seedPost(user.id);
    await db.update(posts).set({ status: 'deleted' }).where(eq(posts.id, postId));

    const out = await ingestPostVector(user, user.username, body(postId));
    expect(out.created).toBe(true);
  });

  it('resolves a null round from the first cycle_run card within 2 h after the post', async () => {
    const { user } = await seedUser();
    const postAt = new Date('2026-10-14T06:10:00Z');
    const postId = await seedPost(user.id, postAt);
    // Before the post: not this post's cycle.
    await seedCycleCard(user.id, new Date(postAt.getTime() - 10 * 60 * 1000), OTHER_ROUND);
    await seedCycleCard(user.id, new Date(postAt.getTime() + 90 * 60 * 1000), ROUND);
    await seedCycleCard(user.id, new Date(postAt.getTime() + 100 * 60 * 1000), OTHER_ROUND);

    const out = await ingestPostVector(user, user.username, body(postId, { roundId: null }));

    const [row] = await db.select().from(postVectors).where(eq(postVectors.id, out.id));
    expect(row.roundId).toBe(ROUND);
    expect(row.source).toBe('backfill');
  });

  it('leaves the round null when the only card is 3 h after the post', async () => {
    const { user } = await seedUser();
    const postAt = new Date('2026-10-14T06:10:00Z');
    const postId = await seedPost(user.id, postAt);
    await seedCycleCard(user.id, new Date(postAt.getTime() + 3 * HOUR), ROUND);

    const out = await ingestPostVector(user, user.username, body(postId, { roundId: null }));

    const [row] = await db.select().from(postVectors).where(eq(postVectors.id, out.id));
    expect(row.roundId).toBeNull();
    expect(row.source).toBe('backfill');
  });

  it("ignores another account's card and non-cycle_run events when resolving", async () => {
    const { user } = await seedUser();
    const { user: other } = await seedUser();
    const postAt = new Date('2026-10-14T06:10:00Z');
    const postId = await seedPost(user.id, postAt);
    await seedCycleCard(other.id, new Date(postAt.getTime() + 10 * 60 * 1000), OTHER_ROUND);
    await db.insert(agentEvents).values({
      userId: user.id,
      type: 'cycle',
      phase: 'act',
      outcome: 'success',
      summary: 'similarity',
      metrics: { kind: 'similarity', roundId: OTHER_ROUND },
      createdAt: new Date(postAt.getTime() + 5 * 60 * 1000),
    });

    const out = await ingestPostVector(user, user.username, body(postId, { roundId: null }));

    const [row] = await db.select().from(postVectors).where(eq(postVectors.id, out.id));
    expect(row.roundId).toBeNull();
  });
});

describe('POST /api/v1/agents/:username/post-vectors', () => {
  const url = (u: string) => `/api/v1/agents/${u}/post-vectors`;

  it('201 on create, 200 with the same id on replay, both in the standard envelope', async () => {
    const { user, key } = await seedUser();
    const postId = await seedPost(user.id);
    const app = createApp();

    const created = await request(app)
      .post(url(user.username))
      .set('Authorization', `Bearer ${key}`)
      .send(body(postId));
    expect(created.status).toBe(201);
    expect(typeof created.body.data.id).toBe('string');

    const replay = await request(app)
      .post(url(user.username))
      .set('Authorization', `Bearer ${key}`)
      .send(body(postId, { roundId: null }));
    expect(replay.status).toBe(200);
    expect(replay.body.data).toEqual({ id: created.body.data.id });
  });

  it('409 on a different non-null round', async () => {
    const { user, key } = await seedUser();
    const postId = await seedPost(user.id);
    const app = createApp();
    await request(app)
      .post(url(user.username))
      .set('Authorization', `Bearer ${key}`)
      .send(body(postId));

    const res = await request(app)
      .post(url(user.username))
      .set('Authorization', `Bearer ${key}`)
      .send(body(postId, { roundId: OTHER_ROUND }));
    expect(res.status).toBe(409);
  });

  it("403 for someone else's post", async () => {
    const { user, key } = await seedUser();
    const { user: other } = await seedUser();
    const postId = await seedPost(other.id);

    const res = await request(createApp())
      .post(url(user.username))
      .set('Authorization', `Bearer ${key}`)
      .send(body(postId));
    expect(res.status).toBe(403);
  });

  it('404 for an unknown post', async () => {
    const { user, key } = await seedUser();
    const res = await request(createApp())
      .post(url(user.username))
      .set('Authorization', `Bearer ${key}`)
      .send(body('does-not-exist'));
    expect(res.status).toBe(404);
  });

  it('400 with a clear message for an echo post', async () => {
    const { user, key } = await seedUser();
    const { user: other } = await seedUser();
    const echoId = await seedEcho(user.id, await seedPost(other.id));

    const res = await request(createApp())
      .post(url(user.username))
      .set('Authorization', `Bearer ${key}`)
      .send(body(echoId));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.fields).toEqual({ postId: 'ECHO' });
    expect(res.body.error.message).toMatch(/echo/i);
  });

  it('400 for a 1023-dim vector', async () => {
    const { user, key } = await seedUser();
    const postId = await seedPost(user.id);
    const res = await request(createApp())
      .post(url(user.username))
      .set('Authorization', `Bearer ${key}`)
      .send(body(postId, { embedding: vec(1023) }));
    expect(res.status).toBe(400);
  });

  it('400 for a malformed round id', async () => {
    const { user, key } = await seedUser();
    const postId = await seedPost(user.id);
    const res = await request(createApp())
      .post(url(user.username))
      .set('Authorization', `Bearer ${key}`)
      .send(body(postId, { roundId: 'round-1' }));
    expect(res.status).toBe(400);
  });

  it('401 when anonymous', async () => {
    const { user } = await seedUser();
    const postId = await seedPost(user.id);
    const res = await request(createApp()).post(url(user.username)).send(body(postId));
    expect(res.status).toBe(401);
  });

  it('403 for an archived (Era 2) account', async () => {
    const { user, key } = await seedUser({ archivedAt: new Date() });
    const postId = await seedPost(user.id);
    const res = await request(createApp())
      .post(url(user.username))
      .set('Authorization', `Bearer ${key}`)
      .send(body(postId));
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('This account is archived (Era 2)');
  });
});

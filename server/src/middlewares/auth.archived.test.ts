/**
 * The Era 2 write seal over the real HTTP stack.
 *
 * An archived account may look after itself (log out, change its password,
 * manage its keys, clear its notifications) and feed the offline bench lane;
 * every write that acts on the world stays 403. The marker that grants the
 * exemption is per route (`allowArchived`), so this suite drives real routes
 * rather than the middleware alone — a marker on the wrong route, or missing
 * from the right one, only shows here.
 */
import { createHash, randomBytes } from 'crypto';
import bcrypt from 'bcrypt';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../app';
import { db } from '../db/client';
import { apiKeys, notifications, posts, users } from '../db/schema';
import { resetDb } from '../test/db-reset';
import type { UserRow } from '../lib/dto';

const SEALED_AT = new Date('2026-10-14T00:00:00.000Z');
const PASSWORD = 'password123';

let seq = 0;
async function seedWithKey(
  over: Partial<typeof users.$inferInsert> = {},
): Promise<{ user: UserRow; key: string }> {
  seq += 1;
  const username = over.username ?? `sealed${seq}`;
  const [user] = await db
    .insert(users)
    .values({
      username,
      usernameDisplay: username,
      email: `${username}@example.test`,
      displayName: username,
      // Cost 4: the hash is only compared, and cost 12 would dominate the suite.
      passwordHash: await bcrypt.hash(PASSWORD, 4),
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

const auth = (key: string) => ({ Authorization: `Bearer ${key}` });

describe('Era 2 seal — what an archived account may still write', () => {
  beforeEach(resetDb);

  it('logs out: 204', async () => {
    const { key } = await seedWithKey({ isAgent: true, archivedAt: SEALED_AT });
    const res = await request(createApp()).post('/api/v1/auth/logout').set(auth(key));
    expect(res.status).toBe(204);
  });

  it('mints and revokes its own API keys: 201, then 204', async () => {
    const { key } = await seedWithKey({ isAgent: true, archivedAt: SEALED_AT });
    const app = createApp();
    const minted = await request(app).post('/api/v1/auth/api-keys').set(auth(key)).send({});
    expect(minted.status).toBe(201);
    const revoked = await request(app)
      .delete(`/api/v1/auth/api-keys/${minted.body.data.apiKey.id}`)
      .set(auth(key));
    expect(revoked.status).toBe(204);
  });

  it('changes its password: 204', async () => {
    const { key } = await seedWithKey({ archivedAt: SEALED_AT });
    const res = await request(createApp())
      .post('/api/v1/auth/password')
      .set(auth(key))
      .send({ currentPassword: PASSWORD, newPassword: 'newpassword456' });
    expect(res.status).toBe(204);
  });

  it('marks notifications read and clears them: 204', async () => {
    const { user, key } = await seedWithKey({ archivedAt: SEALED_AT });
    const { user: actor } = await seedWithKey();
    await db
      .insert(notifications)
      .values({ recipientId: user.id, actorId: actor.id, type: 'follow', read: false });
    const app = createApp();

    const read = await request(app)
      .post('/api/v1/notifications/read')
      .set(auth(key))
      .send({ all: true });
    expect(read.status).toBe(204);
    const [row] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.recipientId, user.id));
    expect(row.read).toBe(true);

    const cleared = await request(app).delete('/api/v1/notifications').set(auth(key));
    expect(cleared.status).toBe(204);
  });

  it('passes the seal on the bench ingest, by exact path in any casing', async () => {
    // An empty body fails validation (400), which runs only AFTER requireUser:
    // a 400 here proves the seal let the request through.
    const { key } = await seedWithKey({ isAgent: true, archivedAt: SEALED_AT });
    const app = createApp();
    for (const path of ['/api/v1/agents/benchmark/runs', '/api/v1/agents/Benchmark/Runs/']) {
      const res = await request(app).post(path).set(auth(key)).send({});
      expect(res.status).toBe(400);
    }
  });

  it('treats HEAD as a read', async () => {
    const { key } = await seedWithKey({ archivedAt: SEALED_AT });
    const res = await request(createApp()).head('/api/v1/auth/me').set(auth(key));
    expect(res.status).toBe(200);
  });
});

describe('Era 2 seal — what stays 403', () => {
  beforeEach(resetDb);

  it('refuses every write that acts on the world', async () => {
    const { user, key } = await seedWithKey({ isAgent: true, archivedAt: SEALED_AT });
    const { user: other } = await seedWithKey();
    const [post] = await db.insert(posts).values({ authorId: other.id, text: 'hi' }).returning();
    const app = createApp();

    const attempts = [
      request(app).post('/api/v1/posts').set(auth(key)).send({ text: 'sealed' }),
      request(app).post(`/api/v1/posts/${post.id}/comments`).set(auth(key)).send({ text: 'x' }),
      request(app).post(`/api/v1/posts/${post.id}/like`).set(auth(key)),
      request(app).post(`/api/v1/posts/${post.id}/bookmark`).set(auth(key)),
      request(app).post(`/api/v1/users/${other.username}/follow`).set(auth(key)),
      request(app)
        .post('/api/v1/conversations')
        .set(auth(key))
        .send({ recipientUsername: other.username }),
      request(app).patch('/api/v1/users/me').set(auth(key)).send({ displayName: 'New' }),
      request(app)
        .post(`/api/v1/agents/${user.username}/events`)
        .set(auth(key))
        .send({ type: 'anomaly', phase: 'anomaly', outcome: 'flagged', summary: 'x' }),
      // A prefix sibling of the bench ingest is not the bench ingest.
      request(app).post('/api/v1/agents/benchmark/runs/extra').set(auth(key)).send({}),
    ];
    const outcomes = (await Promise.all(attempts)).map((r) => [r.status, r.body.error?.message]);
    expect(outcomes).toEqual(attempts.map(() => [403, 'This account is archived (Era 2)']));
  });
});

describe('POST /auth/password revokes API keys', () => {
  beforeEach(resetDb);

  it("kills the changer's own keys, and only theirs", async () => {
    const { user: owner, key: ownerKey } = await seedWithKey();
    // A BYOA agent's key is stored under the AGENT's id, so the owner's
    // password change must leave it working.
    const { key: agentKey } = await seedWithKey({
      isAgent: true,
      ownerId: owner.id,
      passwordHash: null,
    });
    const app = createApp();
    expect((await request(app).get('/api/v1/auth/me').set(auth(ownerKey))).status).toBe(200);

    const changed = await request(app)
      .post('/api/v1/auth/password')
      .set(auth(ownerKey))
      .send({ currentPassword: PASSWORD, newPassword: 'newpassword456' });
    expect(changed.status).toBe(204);

    expect((await request(app).get('/api/v1/auth/me').set(auth(ownerKey))).status).toBe(401);
    expect(await db.select().from(apiKeys).where(eq(apiKeys.userId, owner.id))).toEqual([]);
    expect((await request(app).get('/api/v1/auth/me').set(auth(agentKey))).status).toBe(200);
  });
});

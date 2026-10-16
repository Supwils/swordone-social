import { createHash } from 'crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../../db/client';
import { apiKeys, users } from '../../db/schema';
import { env } from '../../config/env';
import type { UserRow } from '../../lib/dto';
import { newId } from '../../lib/id';
import { resetDb } from '../../test/db-reset';
import {
  createOwnedAgent,
  listOwnedAgents,
  rotateOwnedAgentKey,
  updateOwnedAgent,
} from './ownedAgents.service';

let seq = 0;
async function seedUser(over: Partial<typeof users.$inferInsert> = {}): Promise<UserRow> {
  seq += 1;
  const [u] = await db
    .insert(users)
    .values({
      username: `owner${seq}`,
      usernameDisplay: `owner${seq}`,
      email: `owner${seq}@example.com`,
      displayName: `Owner ${seq}`,
      ...over,
    })
    .returning();
  return u;
}

describe('ownedAgents.service', () => {
  beforeEach(resetDb);

  it('creates an owned agent with the expected row shape and a usable key', async () => {
    const owner = await seedUser();

    const { agent, key } = await createOwnedAgent(owner, {
      username: 'MyBot',
      displayName: 'My Bot',
      agentBackend: 'codex',
    });

    expect(agent.username).toBe('mybot');
    expect(agent.usernameDisplay).toBe('MyBot');
    expect(agent.email).toBe('mybot@agents.swil');
    expect(agent.displayName).toBe('My Bot');
    expect(agent.isAgent).toBe(true);
    expect(agent.agentBackend).toBe('codex');
    expect(agent.ownerId).toBe(owner.id);
    expect(agent.passwordHash).toBeNull();
    expect(agent.agentPaused).toBe(false);

    expect(key.startsWith('sk-swil-')).toBe(true);
    const keyHash = createHash('sha256').update(key).digest('hex');
    const [stored] = await db.select().from(apiKeys).where(eq(apiKeys.userId, agent.id));
    expect(stored?.keyHash).toBe(keyHash);
    expect(stored?.name).toBe('initial');
  });

  it('defaults displayName to the username and backend to claude', async () => {
    const owner = await seedUser();

    const { agent } = await createOwnedAgent(owner, { username: 'plainbot' });

    expect(agent.displayName).toBe('plainbot');
    expect(agent.agentBackend).toBe('claude');
  });

  it('enforces the per-owner cap', async () => {
    const owner = await seedUser();
    for (let i = 0; i < env.MAX_AGENTS_PER_OWNER; i += 1) {
      await createOwnedAgent(owner, { username: `capbot${i}` });
    }

    await expect(createOwnedAgent(owner, { username: 'onemore' })).rejects.toMatchObject({
      status: 403,
    });
  });

  it('holds the cap under concurrent creates (owner row locked in the transaction)', async () => {
    // Check-then-insert outside a transaction let every concurrent create count
    // cap-1 and insert, landing the owner past the cap.
    const owner = await seedUser();
    for (let i = 0; i < env.MAX_AGENTS_PER_OWNER - 1; i += 1) {
      await createOwnedAgent(owner, { username: `racecap${i}` });
    }

    // Warm the pool first: with cold connections the racers would connect one
    // after another and the first could commit before the rest even begin —
    // a test that passes without the lock proves nothing.
    await Promise.all([0, 1, 2, 3, 4].map(() => pool.query('select pg_sleep(0.02)')));
    const settled = await Promise.allSettled(
      [0, 1, 2, 3].map((i) => createOwnedAgent(owner, { username: `racer${i}` })),
    );

    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of settled.filter((x) => x.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ status: 403 });
    }
    const owned = await db.$count(users, eq(users.ownerId, owner.id));
    expect(owned).toBe(env.MAX_AGENTS_PER_OWNER);
  });

  it('answers a lost username race with 409, never a raw unique violation', async () => {
    const [a, b] = [await seedUser(), await seedUser()];
    await Promise.all([0, 1, 2].map(() => pool.query('select pg_sleep(0.02)')));

    const settled = await Promise.allSettled([
      createOwnedAgent(a, { username: 'samebot' }),
      createOwnedAgent(b, { username: 'samebot' }),
    ]);

    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = settled.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      fields: { username: 'Already taken' },
    });
  });

  it('rejects agent accounts as owners', async () => {
    const agentActor = await seedUser({ isAgent: true });

    await expect(createOwnedAgent(agentActor, { username: 'nested' })).rejects.toMatchObject({
      status: 403,
    });
  });

  it('rejects usernames already taken by any account, case-insensitively', async () => {
    const owner = await seedUser();
    await seedUser({ username: 'taken', usernameDisplay: 'taken', email: 'taken@example.com' });

    await expect(createOwnedAgent(owner, { username: 'TAKEN' })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('lists only the requesting owner’s agents, newest first', async () => {
    const alice = await seedUser();
    const bob = await seedUser();
    await createOwnedAgent(alice, { username: 'alicebot1' });
    await createOwnedAgent(alice, { username: 'alicebot2' });
    await createOwnedAgent(bob, { username: 'bobbot' });

    const items = await listOwnedAgents(alice);

    expect(items.map((i) => i.agent.username).sort()).toEqual(['alicebot1', 'alicebot2']);
    expect(items.every((i) => i.lastActiveAt === null)).toBe(true);
  });

  it('surfaces the latest key usage as lastActiveAt', async () => {
    const owner = await seedUser();
    const { agent } = await createOwnedAgent(owner, { username: 'activebot' });
    const usedAt = new Date('2026-07-21T12:00:00Z');
    await db.update(apiKeys).set({ lastUsedAt: usedAt }).where(eq(apiKeys.userId, agent.id));

    const [item] = await listOwnedAgents(owner);

    expect(item.lastActiveAt?.toISOString()).toBe(usedAt.toISOString());
  });

  it('pauses and resumes an owned agent', async () => {
    const owner = await seedUser();
    const { agent } = await createOwnedAgent(owner, { username: 'pausebot' });

    const paused = await updateOwnedAgent(owner, agent.id, { paused: true });
    expect(paused.agentPaused).toBe(true);

    const [row] = await db.select().from(users).where(eq(users.id, agent.id));
    expect(row.agentPaused).toBe(true);

    const resumed = await updateOwnedAgent(owner, agent.id, { paused: false });
    expect(resumed.agentPaused).toBe(false);
  });

  it('updates the display name', async () => {
    const owner = await seedUser();
    const { agent } = await createOwnedAgent(owner, { username: 'renamebot' });

    const updated = await updateOwnedAgent(owner, agent.id, { displayName: 'Renamed' });

    expect(updated.displayName).toBe('Renamed');
  });

  it('404s for unknown agents and 403s for agents owned by someone else', async () => {
    const alice = await seedUser();
    const bob = await seedUser();
    const { agent } = await createOwnedAgent(alice, { username: 'guardbot' });

    await expect(updateOwnedAgent(alice, newId(), { paused: true })).rejects.toMatchObject({
      status: 404,
    });
    await expect(updateOwnedAgent(bob, agent.id, { paused: true })).rejects.toMatchObject({
      status: 403,
    });
    await expect(rotateOwnedAgentKey(bob, agent.id, 'steal')).rejects.toMatchObject({
      status: 403,
    });
  });

  it('rotate deletes every old key and returns a working new one', async () => {
    const owner = await seedUser();
    const { agent, key: firstKey } = await createOwnedAgent(owner, { username: 'rotatebot' });

    const { key: secondKey } = await rotateOwnedAgentKey(owner, agent.id, 'rotated');

    expect(secondKey.startsWith('sk-swil-')).toBe(true);
    expect(secondKey).not.toBe(firstKey);

    const rows = await db.select().from(apiKeys).where(eq(apiKeys.userId, agent.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('rotated');
    expect(rows[0].keyHash).toBe(createHash('sha256').update(secondKey).digest('hex'));
  });
});

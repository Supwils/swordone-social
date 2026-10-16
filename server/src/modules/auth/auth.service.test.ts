import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { apiKeys, users } from '../../db/schema';
import { env } from '../../config/env';
import type { UserRow } from '../../lib/dto';
import { newId } from '../../lib/id';
import { resetDb } from '../../test/db-reset';
import { uniqueViolationConflict } from '../../lib/errors';
import {
  authenticate,
  changePassword,
  createApiKey,
  listApiKeys,
  register,
  revokeApiKey,
} from './auth.service';

// The service reads `env.AGENT_SETUP_TOKEN`, which is captured from
// process.env at env.ts import time. Mutating process.env after import has no
// effect, so we mutate the parsed `env` object directly and restore it. We also
// keep process.env in sync for good measure.
const ORIGINAL_ENV_TOKEN = env.AGENT_SETUP_TOKEN;
const ORIGINAL_PROC_TOKEN = process.env.AGENT_SETUP_TOKEN;
const AGENT_TOKEN = 'agent-setup-token-abcdef';

function setAgentToken(value: string | undefined): void {
  env.AGENT_SETUP_TOKEN = value;
  if (value === undefined) delete process.env.AGENT_SETUP_TOKEN;
  else process.env.AGENT_SETUP_TOKEN = value;
}

async function seedUser(
  username: string,
  over: Partial<typeof users.$inferInsert> = {},
): Promise<UserRow> {
  const [u] = await db
    .insert(users)
    .values({
      username,
      usernameDisplay: username,
      email: `${username}@example.com`,
      displayName: username,
      ...over,
    })
    .returning();
  return u;
}

describe('auth.service', () => {
  beforeEach(resetDb);
  afterEach(() => {
    env.AGENT_SETUP_TOKEN = ORIGINAL_ENV_TOKEN;
    if (ORIGINAL_PROC_TOKEN === undefined) delete process.env.AGENT_SETUP_TOKEN;
    else process.env.AGENT_SETUP_TOKEN = ORIGINAL_PROC_TOKEN;
  });

  describe('register', () => {
    it('creates a user, lowercasing username/email and hashing the password', async () => {
      const user = await register({
        username: 'Alice',
        email: 'Alice@Example.com',
        password: 'password123',
        displayName: 'Alice L',
      });

      expect(user.username).toBe('alice');
      expect(user.email).toBe('alice@example.com');
      expect(user.usernameDisplay).toBe('Alice');
      expect(user.displayName).toBe('Alice L');
      expect(user.isAgent).toBe(false);
      expect(user.passwordHash).toBeTruthy();
      expect(user.passwordHash).not.toBe('password123');

      const [row] = await db.select().from(users).where(eq(users.id, user.id));
      expect(await bcrypt.compare('password123', row.passwordHash!)).toBe(true);
    });

    it('defaults displayName to the username when omitted', async () => {
      const user = await register({
        username: 'noname',
        email: 'noname@example.com',
        password: 'password123',
      });
      expect(user.displayName).toBe('noname');
    });

    it('rejects a duplicate username with a 409 conflict', async () => {
      await register({ username: 'bob', email: 'bob@example.com', password: 'password123' });
      await expect(
        register({ username: 'BOB', email: 'other@example.com', password: 'password123' }),
      ).rejects.toMatchObject({ status: 409, fields: { username: 'Already taken' } });
    });

    it('rejects a duplicate email with a 409 conflict', async () => {
      await register({ username: 'carol', email: 'shared@example.com', password: 'password123' });
      await expect(
        register({ username: 'dave', email: 'Shared@example.com', password: 'password123' }),
      ).rejects.toMatchObject({ status: 409, fields: { email: 'Already taken' } });
    });

    it('forbids an agent registration when no setup token is configured', async () => {
      setAgentToken(undefined);
      await expect(
        register({
          username: 'agent1',
          email: 'agent1@example.com',
          password: 'password123',
          isAgent: true,
          agentSetupToken: 'whatever-token-value',
        }),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('forbids an agent registration when the provided token is wrong', async () => {
      setAgentToken(AGENT_TOKEN);
      await expect(
        register({
          username: 'agent2',
          email: 'agent2@example.com',
          password: 'password123',
          isAgent: true,
          agentSetupToken: 'wrong-token-value-here',
        }),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('creates an agent account when the correct setup token is provided', async () => {
      setAgentToken(AGENT_TOKEN);
      const user = await register({
        username: 'agent3',
        email: 'agent3@example.com',
        password: 'password123',
        isAgent: true,
        agentSetupToken: AGENT_TOKEN,
      });
      expect(user.isAgent).toBe(true);
    });
  });

  it('a register that loses the race to the unique index is a 409, not a 500', async () => {
    // Both pass the pre-check (bcrypt sits between it and the insert), so the
    // loser's error is the real drizzle-wrapped pg 23505 — the errorHandler
    // maps it through uniqueViolationConflict.
    const input = { username: 'racer', email: 'racer@example.com', password: 'password123' };
    const settled = await Promise.allSettled([register(input), register(input)]);

    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = (settled.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason;
    const asHttp = (lost as { status?: number }).status ? lost : uniqueViolationConflict(lost);
    expect(asHttp).toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(Object.keys((asHttp as { fields?: object }).fields ?? {})).not.toHaveLength(0);
  });

  describe('authenticate', () => {
    it('authenticates by username and bumps lastSeenAt', async () => {
      await register({ username: 'eve', email: 'eve@example.com', password: 'password123' });
      const old = new Date(Date.now() - 60_000);
      await db.update(users).set({ lastSeenAt: old }).where(eq(users.username, 'eve'));

      const user = await authenticate({ usernameOrEmail: 'eve', password: 'password123' });
      expect(user.username).toBe('eve');
      expect(user.lastSeenAt.getTime()).toBeGreaterThan(old.getTime());
    });

    it('authenticates by email, trimming and lowercasing the identifier', async () => {
      await register({ username: 'frank', email: 'frank@example.com', password: 'password123' });
      const user = await authenticate({
        usernameOrEmail: '  FRANK@EXAMPLE.COM  ',
        password: 'password123',
      });
      expect(user.username).toBe('frank');
    });

    it('rejects a wrong password with 401', async () => {
      await register({ username: 'grace', email: 'grace@example.com', password: 'password123' });
      await expect(
        authenticate({ usernameOrEmail: 'grace', password: 'wrongpassword' }),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('rejects a nonexistent user with 401', async () => {
      await expect(
        authenticate({ usernameOrEmail: 'nobody', password: 'password123' }),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('rejects a user with no passwordHash (OAuth-only) with 401', async () => {
      await seedUser('oauthonly'); // passwordHash defaults to null
      await expect(
        authenticate({ usernameOrEmail: 'oauthonly', password: 'password123' }),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('forbids a non-active (suspended) account with 403', async () => {
      await register({ username: 'heidi', email: 'heidi@example.com', password: 'password123' });
      await db.update(users).set({ status: 'suspended' }).where(eq(users.username, 'heidi'));
      await expect(
        authenticate({ usernameOrEmail: 'heidi', password: 'password123' }),
      ).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('changePassword', () => {
    it('updates the hash when the current password is correct', async () => {
      const user = await register({
        username: 'ivan',
        email: 'ivan@example.com',
        password: 'password123',
      });

      await expect(changePassword(user, 'password123', 'newpassword456')).resolves.toBeUndefined();

      const [row] = await db.select().from(users).where(eq(users.id, user.id));
      expect(await bcrypt.compare('newpassword456', row.passwordHash!)).toBe(true);
      expect(await bcrypt.compare('password123', row.passwordHash!)).toBe(false);
    });

    it('rejects a wrong current password with 401', async () => {
      const user = await register({
        username: 'judy',
        email: 'judy@example.com',
        password: 'password123',
      });
      await expect(changePassword(user, 'wrongcurrent', 'newpassword456')).rejects.toMatchObject({
        status: 401,
      });
    });

    it('forbids changing password on an account with no passwordHash', async () => {
      const user = await seedUser('mallory'); // passwordHash null
      await expect(changePassword(user, 'anything', 'newpassword456')).rejects.toMatchObject({
        status: 403,
      });
    });
  });

  describe('API keys', () => {
    it('createApiKey returns a raw sk-swil key and persists a hashed row', async () => {
      const user = await seedUser('keyuser');
      const { key, doc } = await createApiKey(user, 'CI token');

      expect(key.startsWith('sk-swil-')).toBe(true);
      expect(doc.userId).toBe(user.id);
      expect(doc.name).toBe('CI token');
      expect(doc.keyHash).not.toBe(key); // stored hashed, not raw

      const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, doc.id));
      expect(row.keyHash).toBe(doc.keyHash);
    });

    it('listApiKeys returns only the user own keys, newest first', async () => {
      const user = await seedUser('owner');
      const other = await seedUser('intruder');

      const base = Date.now();
      await db.insert(apiKeys).values([
        { userId: user.id, name: 'old', keyHash: 'hash-old', createdAt: new Date(base - 2000) },
        { userId: user.id, name: 'new', keyHash: 'hash-new', createdAt: new Date(base) },
        { userId: user.id, name: 'mid', keyHash: 'hash-mid', createdAt: new Date(base - 1000) },
        { userId: other.id, name: 'theirs', keyHash: 'hash-other', createdAt: new Date(base) },
      ]);

      const list = await listApiKeys(user);
      expect(list.map((k) => k.name)).toEqual(['new', 'mid', 'old']);
      expect(list.every((k) => k.userId === user.id)).toBe(true);
    });

    it('revokeApiKey deletes the caller own key', async () => {
      const user = await seedUser('revoker');
      const { doc } = await createApiKey(user, 'to-revoke');

      await expect(revokeApiKey(user, doc.id)).resolves.toBeUndefined();
      const rows = await db.select().from(apiKeys).where(eq(apiKeys.id, doc.id));
      expect(rows).toHaveLength(0);
    });

    it('forbids revoking a key owned by another user (and leaves it intact)', async () => {
      const owner = await seedUser('owner2');
      const attacker = await seedUser('attacker');
      const { doc } = await createApiKey(owner, 'victim-key');

      await expect(revokeApiKey(attacker, doc.id)).rejects.toMatchObject({ status: 403 });
      const rows = await db.select().from(apiKeys).where(eq(apiKeys.id, doc.id));
      expect(rows).toHaveLength(1);
    });

    it('rejects revoking a missing key with 404', async () => {
      const user = await seedUser('missing');
      await expect(revokeApiKey(user, newId())).rejects.toMatchObject({ status: 404 });
    });

    it('orders keys deterministically and revokes the right one among many', async () => {
      const user = await seedUser('multi');
      const a = await createApiKey(user, 'a');
      const b = await createApiKey(user, 'b');
      await createApiKey(user, 'c');

      await revokeApiKey(user, b.doc.id);
      const remaining = await listApiKeys(user);
      const names = remaining.map((k) => k.name).sort();
      expect(names).toEqual(['a', 'c']);
      expect(remaining.find((k) => k.id === a.doc.id)).toBeDefined();
    });
  });
});

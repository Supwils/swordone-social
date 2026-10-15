import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import request from 'supertest';
import { createApp } from '../../app';
import { db } from '../../db/client';
import { users } from '../../db/schema';
import { resetDb } from '../../test/db-reset';
import { envelopeData, expectContract } from '../../test/contract';
import {
  AgentOpsDTOSchema,
  ApiKeyDTOSchema,
  ApiKeyListSchema,
  CreatedAgentKeySchema,
  CreatedApiKeySchema,
  CreatedOwnedAgentSchema,
  MeDTOSchema,
  OwnedAgentDTOSchema,
  UserDTOSchema,
  UserLiteDTOSchema,
} from '../../contract/users';

/**
 * The account endpoints' SERIALISED bodies against the contract, through the
 * real router stack and the test database. Dates only become ISO strings
 * inside `res.json`, so these parse `res.body`, never a controller's value.
 */

const userBody = z.object({ user: UserDTOSchema }).strict();

async function signUp(username: string) {
  const agent = request.agent(createApp());
  const res = await agent
    .post('/api/v1/auth/register')
    .send({ username, email: `${username}@example.com`, password: 'password123' })
    .expect(201);
  return { agent, res };
}

// Reset once: every test signs up its own, distinctly named accounts and
// asserts only on them, so tests do not need a fresh database each.
beforeAll(resetDb, 30_000);

describe('auth + profile bodies', () => {
  it('register, login and PATCH /users/me return { user: UserDTO }', async () => {
    const { agent, res } = await signUp('ada');
    expect(expectContract(userBody, envelopeData(res.body)).user.email).toBe('ada@example.com');

    const login = await request(createApp())
      .post('/api/v1/auth/login')
      .send({ usernameOrEmail: 'ada', password: 'password123' })
      .expect(200);
    expectContract(userBody, envelopeData(login.body));

    // A partial preferences patch reads back partial (every field optional).
    const patched = await agent
      .patch('/api/v1/users/me')
      .send({ preferences: { language: 'zh' } })
      .expect(200);
    expect(expectContract(userBody, envelopeData(patched.body)).user.preferences).toEqual({
      language: 'zh',
    });
  });

  it('GET /auth/me is a MeDTO — no agentOps for a human, agentOps for an agent', async () => {
    const { agent } = await signUp('owner1');
    const human = await agent.get('/api/v1/auth/me').expect(200);
    expect(expectContract(MeDTOSchema, envelopeData(human.body)).agentOps).toBeUndefined();

    const created = await agent
      .post('/api/v1/users/me/agents')
      .send({ username: 'ownedbot', agentBackend: 'claude:claude-haiku-5-5' })
      .expect(201);
    const { key } = expectContract(CreatedOwnedAgentSchema, envelopeData(created.body));

    const asAgent = await request(createApp())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${key}`)
      .expect(200);
    const me = expectContract(MeDTOSchema, envelopeData(asAgent.body));
    expect(me.user.isAgent).toBe(true);
    expectContract(AgentOpsDTOSchema, me.agentOps);
  });

  it('GET /users/:username — public, self and a BYOA agent with its owner badge', async () => {
    const { agent } = await signUp('owner2');
    await agent.post('/api/v1/users/me/agents').send({ username: 'byoabot' }).expect(201);

    const anon = await request(createApp()).get('/api/v1/users/owner2').expect(200);
    const pub = expectContract(userBody, envelopeData(anon.body)).user;
    expect(pub.email).toBeUndefined();

    const self = await agent.get('/api/v1/users/owner2').expect(200);
    expect(expectContract(userBody, envelopeData(self.body)).user.email).toBe('owner2@example.com');

    const byoa = await request(createApp()).get('/api/v1/users/byoabot').expect(200);
    expect(expectContract(userBody, envelopeData(byoa.body)).user.owner?.username).toBe('owner2');

    // An archived account still serves a readable profile.
    await db.update(users).set({ archivedAt: new Date() }).where(eq(users.username, 'owner2'));
    const sealed = await request(createApp()).get('/api/v1/users/owner2').expect(200);
    expect(expectContract(userBody, envelopeData(sealed.body)).user.archivedAt).not.toBeNull();
  });

  it('GET /users?search= lists UserLiteDTOs', async () => {
    await signUp('searchme');
    const res = await request(createApp()).get('/api/v1/users?search=search').expect(200);
    const { items } = expectContract(
      z.object({ items: z.array(UserLiteDTOSchema) }).strict(),
      envelopeData(res.body),
    );
    expect(items.map((u) => u.username)).toContain('searchme');
  });
});

describe('API keys', () => {
  it('create returns the key once; list returns ApiKeyDTOs with lastUsedAt', async () => {
    const { agent } = await signUp('keyholder');
    const created = await agent.post('/api/v1/auth/api-keys').send({ name: 'ci' }).expect(201);
    const { key, apiKey } = expectContract(CreatedApiKeySchema, envelopeData(created.body));
    expect(apiKey.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const unused = await agent.get('/api/v1/auth/api-keys').expect(200);
    const before = expectContract(ApiKeyListSchema, envelopeData(unused.body)).apiKeys;
    expect(before).toHaveLength(1);
    expect(expectContract(ApiKeyDTOSchema, before[0]).lastUsedAt).toBeNull();

    await request(createApp())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${key}`)
      .expect(200);
    const used = await agent.get('/api/v1/auth/api-keys').expect(200);
    const after = expectContract(ApiKeyListSchema, envelopeData(used.body)).apiKeys;
    expect(after[0].lastUsedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('owned agents', () => {
  it('list, create, update and rotate-key bodies', async () => {
    const { agent } = await signUp('owner3');

    const created = await agent
      .post('/api/v1/users/me/agents')
      .send({ username: 'mybot', displayName: 'My Bot' })
      .expect(201);
    const { agent: dto } = expectContract(CreatedOwnedAgentSchema, envelopeData(created.body));
    expect(dto.lastActiveAt).toBeNull();

    const list = await agent.get('/api/v1/users/me/agents').expect(200);
    const { items } = expectContract(
      z.object({ items: z.array(OwnedAgentDTOSchema) }).strict(),
      envelopeData(list.body),
    );
    expect(items.map((a) => a.username)).toEqual(['mybot']);

    const paused = await agent
      .patch(`/api/v1/users/me/agents/${dto.id}`)
      .send({ paused: true })
      .expect(200);
    expect(
      expectContract(z.object({ agent: OwnedAgentDTOSchema }).strict(), envelopeData(paused.body))
        .agent.paused,
    ).toBe(true);

    const rotated = await agent
      .post(`/api/v1/users/me/agents/${dto.id}/rotate-key`)
      .send({})
      .expect(201);
    expectContract(CreatedAgentKeySchema, envelopeData(rotated.body));
  });
});

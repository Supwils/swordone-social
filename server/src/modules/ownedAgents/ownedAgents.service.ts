import { and, desc, eq, inArray, ne, or } from 'drizzle-orm';
import { db } from '../../db/client';
import { apiKeys, users } from '../../db/schema';
import { env } from '../../config/env';
import { AppError, uniqueViolationConflict } from '../../lib/errors';
import type { UserRow } from '../../lib/dto';
import { createApiKey } from '../auth/auth.service';
import type { CreateOwnedAgentInput, UpdateOwnedAgentInput } from './ownedAgents.schemas';

interface OwnedAgentSummary {
  agent: UserRow;
  lastActiveAt: Date | null;
}

/**
 * Create an agent account owned by `owner`. The account has no password
 * (API-key auth only); the initial key is created here and returned exactly
 * once. Email is synthesized with the same convention as `swil-agent register`.
 */
export async function createOwnedAgent(
  owner: UserRow,
  input: CreateOwnedAgentInput,
): Promise<{ agent: UserRow; key: string }> {
  if (owner.isAgent) {
    throw AppError.forbidden('Agent accounts cannot own other agents');
  }

  const username = input.username.toLowerCase();
  const email = `${username}@agents.swil`;

  // Cap check and insert in ONE transaction, serialised per owner by locking
  // the owner's row: two concurrent creates used to both count N-1 and both
  // insert, landing the owner one past the cap. The username pre-check stays
  // for the friendly 409; a create that still loses the race to the unique
  // index is a 409 too (`uniqueViolationConflict`), never a 500.
  return db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, owner.id)).for('update');

    const ownedCount = await tx.$count(
      users,
      and(eq(users.ownerId, owner.id), ne(users.status, 'deleted')),
    );
    if (ownedCount >= env.MAX_AGENTS_PER_OWNER) {
      throw AppError.forbidden(`Agent limit reached (${env.MAX_AGENTS_PER_OWNER} per account)`);
    }

    const [existing] = await tx
      .select({ username: users.username })
      .from(users)
      .where(or(eq(users.username, username), eq(users.email, email)))
      .limit(1);
    if (existing) {
      throw AppError.conflict('Username already taken', { username: 'Already taken' });
    }

    let agent: UserRow;
    try {
      [agent] = await tx
        .insert(users)
        .values({
          username,
          usernameDisplay: input.username,
          email,
          emailVerified: false,
          displayName: input.displayName ?? input.username,
          isAgent: true,
          agentBackend: input.agentBackend ?? 'claude',
          ownerId: owner.id,
          // passwordHash intentionally omitted (NULL): API-key auth only.
        })
        .returning();
    } catch (err) {
      // The synthesized email is the username's twin, so either index means
      // "username taken" to this caller.
      if (uniqueViolationConflict(err)) {
        throw AppError.conflict('Username already taken', { username: 'Already taken' });
      }
      throw err;
    }

    const { key } = await createApiKey(agent, 'initial', tx);
    return { agent, key };
  });
}

export async function listOwnedAgents(owner: UserRow): Promise<OwnedAgentSummary[]> {
  const agents = await db
    .select()
    .from(users)
    .where(and(eq(users.ownerId, owner.id), ne(users.status, 'deleted')))
    .orderBy(desc(users.createdAt));

  if (agents.length === 0) return [];

  const keys = await db
    .select({ userId: apiKeys.userId, lastUsedAt: apiKeys.lastUsedAt })
    .from(apiKeys)
    .where(
      inArray(
        apiKeys.userId,
        agents.map((a) => a.id),
      ),
    );

  const lastActiveByAgent = new Map<string, Date>();
  for (const k of keys) {
    if (!k.lastUsedAt) continue;
    const prev = lastActiveByAgent.get(k.userId);
    if (!prev || k.lastUsedAt > prev) lastActiveByAgent.set(k.userId, k.lastUsedAt);
  }

  return agents.map((agent) => ({
    agent,
    lastActiveAt: lastActiveByAgent.get(agent.id) ?? null,
  }));
}

async function findOwnedAgent(owner: UserRow, agentId: string): Promise<UserRow> {
  const [agent] = await db.select().from(users).where(eq(users.id, agentId)).limit(1);
  if (!agent || !agent.isAgent || agent.status === 'deleted') {
    throw AppError.notFound('Agent not found');
  }
  if (agent.ownerId !== owner.id) throw AppError.forbidden('Not your agent');
  return agent;
}

export async function updateOwnedAgent(
  owner: UserRow,
  agentId: string,
  patch: UpdateOwnedAgentInput,
): Promise<UserRow> {
  const agent = await findOwnedAgent(owner, agentId);

  const set: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
  if (patch.paused !== undefined) set.agentPaused = patch.paused;
  if (patch.displayName !== undefined) set.displayName = patch.displayName;

  const [updated] = await db.update(users).set(set).where(eq(users.id, agent.id)).returning();
  return updated;
}

/**
 * Rotate the agent's credentials: every existing key is deleted and one new
 * key is created and returned. Destructive by design — a leaked key dies here.
 */
export async function rotateOwnedAgentKey(
  owner: UserRow,
  agentId: string,
  name: string,
): Promise<{ key: string }> {
  const agent = await findOwnedAgent(owner, agentId);

  await db.delete(apiKeys).where(eq(apiKeys.userId, agent.id));
  const { key } = await createApiKey(agent, name);
  return { key };
}

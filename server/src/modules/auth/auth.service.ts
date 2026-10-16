import bcrypt from 'bcrypt';
import { randomBytes, createHash } from 'crypto';
import { and, desc, eq, or, sql, type InferSelectModel } from 'drizzle-orm';
import { db } from '../../db/client';
import { users, apiKeys } from '../../db/schema';
import { AppError } from '../../lib/errors';
import { env } from '../../config/env';
import type { UserRow } from '../../lib/dto';
import type { RegisterInput, LoginInput } from './auth.schemas';

export type ApiKeyRow = InferSelectModel<typeof apiKeys>;

const BCRYPT_COST = 12;

export async function register(input: RegisterInput): Promise<UserRow> {
  const username = input.username.toLowerCase();
  const email = input.email.toLowerCase();

  const [existing] = await db
    .select({ username: users.username, email: users.email })
    .from(users)
    .where(or(eq(users.username, username), eq(users.email, email)))
    .limit(1);
  if (existing) {
    const fields: Record<string, string> = {};
    if (existing.username === username) fields.username = 'Already taken';
    if (existing.email === email) fields.email = 'Already taken';
    throw AppError.conflict('Account already exists', fields);
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
  const isAgent = input.isAgent === true;
  if (isAgent && (!env.AGENT_SETUP_TOKEN || input.agentSetupToken !== env.AGENT_SETUP_TOKEN)) {
    throw AppError.forbidden('Agent account setup is not enabled for this request');
  }

  const [user] = await db
    .insert(users)
    .values({
      username,
      usernameDisplay: input.username,
      email,
      emailVerified: false,
      passwordHash,
      authProviders: [{ provider: 'local' }],
      displayName: input.displayName ?? input.username,
      isAgent,
    })
    .returning();

  return user;
}

export async function authenticate(input: LoginInput): Promise<UserRow> {
  const identifier = input.usernameOrEmail.toLowerCase().trim();
  const [user] = await db
    .select()
    .from(users)
    .where(or(eq(users.username, identifier), eq(users.email, identifier)))
    .limit(1);

  if (!user || !user.passwordHash) {
    throw AppError.unauthenticated('Invalid username or password');
  }
  if (user.status !== 'active') {
    throw AppError.forbidden('Account is not active');
  }

  const ok = await bcrypt.compare(input.password, user.passwordHash);
  if (!ok) {
    throw AppError.unauthenticated('Invalid username or password');
  }

  const [updated] = await db
    .update(users)
    .set({ lastSeenAt: new Date() })
    .where(eq(users.id, user.id))
    .returning();
  return updated;
}

export async function changePassword(
  user: UserRow,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  if (!user.passwordHash) {
    throw AppError.forbidden('This account has no password set');
  }
  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) throw AppError.unauthenticated('Current password is incorrect');

  const hash = await bcrypt.hash(newPassword, BCRYPT_COST);
  // A password change is how a person takes their account back, so it also
  // revokes every API key the account holds — a leaked key must not outlive
  // the password it was minted under. Only the changer's OWN keys: a BYOA
  // agent's keys are stored under the agent's user id (`createOwnedAgent` mints
  // them for the agent row), so an owner's password change leaves their agents
  // running; rotating those is `rotate-key`'s job. The agent runtime never
  // calls /auth/password, so this never touches the roster's keys.
  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash: hash }).where(eq(users.id, user.id));
    await tx.delete(apiKeys).where(eq(apiKeys.userId, user.id));
  });
}

export async function destroyOtherSessions(userId: string, currentSid: string): Promise<void> {
  // connect-pg-simple stores the express session object in `sess` (json).
  // The userId lives at the top level of that object (SessionData.userId).
  await db.execute(
    sql`DELETE FROM "session" WHERE "sid" <> ${currentSid} AND "sess"->>'userId' = ${userId}`,
  );
}

// ---------- API Keys ----------

/** `db` or a transaction handle — anything that can run the key insert. */
type KeyWriter = Pick<typeof db, 'insert'>;

export async function createApiKey(
  user: Pick<UserRow, 'id'>,
  name: string,
  writer: KeyWriter = db,
): Promise<{ key: string; doc: ApiKeyRow }> {
  const rawKey = `sk-swil-${randomBytes(32).toString('hex')}`;
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  const [doc] = await writer.insert(apiKeys).values({ userId: user.id, name, keyHash }).returning();
  return { key: rawKey, doc };
}

export async function listApiKeys(user: UserRow): Promise<ApiKeyRow[]> {
  return db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.userId, user.id))
    .orderBy(desc(apiKeys.createdAt));
}

export async function revokeApiKey(user: UserRow, keyId: string): Promise<void> {
  const [doc] = await db.select().from(apiKeys).where(eq(apiKeys.id, keyId)).limit(1);
  if (!doc) throw AppError.notFound('API key not found');
  if (doc.userId !== user.id) throw AppError.forbidden('Not your API key');
  await db.delete(apiKeys).where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, user.id)));
}

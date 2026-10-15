import { beforeEach, describe, expect, it } from 'vitest';
import { asc } from 'drizzle-orm';
import { db } from '../../../db/client';
import { users } from '../../../db/schema';
import { resetDb } from '../../../test/db-reset';
import { eraCondition } from './era';

async function seed(
  username: string,
  over: Partial<typeof users.$inferInsert> = {},
): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      username,
      usernameDisplay: username,
      email: `${username}@example.test`,
      displayName: username,
      ...over,
    })
    .returning({ id: users.id });
  return u.id;
}

async function usernamesIn(era: 2 | 3): Promise<string[]> {
  const rows = await db
    .select({ username: users.username })
    .from(users)
    .where(eraCondition(era))
    .orderBy(asc(users.username));
  return rows.map((r) => r.username);
}

describe('eraCondition', () => {
  beforeEach(async () => {
    await resetDb();
    const owner = await seed('owner_h');
    await seed('live_a', { isAgent: true });
    await seed('byoa_a', { isAgent: true, ownerId: owner });
    await seed('human_h', { isAgent: false });
    await seed('sealed_a', { isAgent: true, archivedAt: new Date('2026-10-14T00:00:00Z') });
    await seed('sealed_h', { isAgent: false, archivedAt: new Date('2026-10-14T00:00:00Z') });
  });

  it('era 3 = non-archived first-party agents only', async () => {
    expect(await usernamesIn(3)).toEqual(['live_a']);
  });

  it('era 2 = every archived account, agent or simulated human', async () => {
    expect(await usernamesIn(2)).toEqual(['sealed_a', 'sealed_h']);
  });
});

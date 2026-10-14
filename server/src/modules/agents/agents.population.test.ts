import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db/client';
import { resetDb } from '../../test/db-reset';
import { personalitySnapshots, users } from '../../db/schema';
import { computeCohesion } from './agents.population';

async function seedAgent(username: string, archivedAt: Date | null): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      username,
      usernameDisplay: username,
      email: `${username}@example.test`,
      displayName: username,
      isAgent: true,
      archivedAt,
    })
    .returning();
  return u.id;
}

function vec(...head: number[]): number[] {
  return [...head, ...new Array<number>(1024 - head.length).fill(0)];
}

async function seedSnapshot(userId: string, embedding: number[], hash: string): Promise<void> {
  await db.insert(personalitySnapshots).values({
    userId,
    capturedAt: new Date(),
    contentHash: hash,
    embedding,
    archivePath: 'x',
  });
}

describe('computeCohesion', () => {
  beforeEach(resetDb);

  it('ignores vectors of archived users', async () => {
    const a = await seedAgent('live_a', null);
    const b = await seedAgent('live_b', null);
    const sealed = await seedAgent('sealed_c', new Date());
    await seedSnapshot(a, vec(1, 0), 'h1');
    await seedSnapshot(b, vec(1, 0), 'h2');
    // Orthogonal to the live pair: would drag cohesion below 1 if counted.
    await seedSnapshot(sealed, vec(0, 1), 'h3');

    const c = await computeCohesion();

    expect(c.personaCohesion).toBeCloseTo(1, 5);
    expect(c.n).toBe(2);
  });
});

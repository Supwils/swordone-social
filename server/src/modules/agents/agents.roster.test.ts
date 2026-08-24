import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db/client';
import { resetDb } from '../../test/db-reset';
import { comments, likes, personalitySnapshots, posts, users } from '../../db/schema';
import type { UserRow } from '../../lib/dto';
import { getAgentStats, listAgents } from './agents.roster';

/**
 * Integration suite against the real test Postgres. `listAgents`'s
 * sparkline/fidelity math is already pinned in agents.service.test.ts —
 * here we pin the roster's MEMBERSHIP and cohort rules, and give
 * `getAgentStats` (cadence + AI/human engagement split) its first tests.
 */

const DIM = 1024;
const axis0 = (() => {
  const a = Array(DIM).fill(0);
  a[0] = 1;
  return a;
})();

let seq = 0;

async function seedUser(over: Partial<typeof users.$inferInsert> = {}): Promise<UserRow> {
  seq += 1;
  const [u] = await db
    .insert(users)
    .values({
      username: `r${seq}`,
      usernameDisplay: `r${seq}`,
      email: `r${seq}@example.com`,
      displayName: `R${seq}`,
      ...over,
    })
    .returning();
  return u;
}

async function seedSnapshot(userId: string) {
  seq += 1;
  await db.insert(personalitySnapshots).values({
    userId,
    capturedAt: new Date(),
    contentHash: `roster-hash-${seq}`,
    embedding: axis0,
    snapshotType: 'dream',
    archivePath: 'agents/x/personality.archive.md',
  });
}

async function seedPost(authorId: string, over: Partial<typeof posts.$inferInsert> = {}) {
  const [p] = await db
    .insert(posts)
    .values({ authorId, text: 'hello', ...over })
    .returning();
  return p;
}

beforeEach(resetDb);

describe('agents.roster.listAgents membership and cohorts', () => {
  it('rosters agents and dream-loop humans; plain humans and inactive accounts stay out', async () => {
    await seedUser({ username: 'zenith', isAgent: true, followerCount: 9 });
    const owner = await seedUser({ username: 'owner1', followerCount: 0 });
    const byoa = await seedUser({
      username: 'byoabot',
      isAgent: true,
      ownerId: owner.id,
      agentBackend: 'claude',
      followerCount: 5,
    });
    // A simulated human INSIDE the loop: isAgent=false but snapshotted. The
    // roster keeps its agentBackend on purpose — /lab is the analysis surface.
    const simHuman = await seedUser({
      username: 'fenziys',
      isAgent: false,
      agentBackend: 'haiku',
      followerCount: 7,
    });
    await seedSnapshot(simHuman.id);
    const suspended = await seedUser({
      username: 'ghosted',
      isAgent: true,
      status: 'suspended',
    });

    const out = await listAgents();
    const names = out.map((a) => a.username);

    expect(names).toEqual(['zenith', 'fenziys', 'byoabot']); // follower desc
    expect(names).not.toContain(owner.username);
    expect(names).not.toContain(suspended.username);

    const byName = new Map(out.map((a) => [a.username, a]));
    expect(byName.get('zenith')).toMatchObject({ isAgent: true, cohort: 'first-party' });
    expect(byName.get('zenith')).not.toHaveProperty('agentBackend');
    expect(byName.get('byoabot')).toMatchObject({
      isAgent: true,
      cohort: 'community',
      agentBackend: 'claude',
    });
    expect(byName.get('fenziys')).toMatchObject({
      isAgent: false,
      cohort: 'human',
      agentBackend: 'haiku',
    });
    // Its snapshot is what admits it — so it carries a (flat) drift series.
    expect(byName.get('fenziys')).toMatchObject({ postsLast7d: 0, driftSparkline: [0] });
    expect(byName.get('fenziys')?.lastSnapshotAt).not.toBeNull();
    expect(byoa.id).toBeTruthy();
  });
});

describe('agents.roster.getAgentStats', () => {
  it('rejects an unknown account with 404', async () => {
    await expect(getAgentStats('nobody', '7d')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });

  it('builds a zero-filled UTC cadence and splits engagement by actor species', async () => {
    const agent = await seedUser({ username: 'statsbot', isAgent: true });
    const aiPeer = await seedUser({ username: 'aipeer', isAgent: true });
    const human = await seedUser({ username: 'humanpal', isAgent: false });

    // The agent's own posts: two active today, one deleted (must not count).
    const p1 = await seedPost(agent.id);
    const p2 = await seedPost(agent.id);
    await seedPost(agent.id, { status: 'deleted' });

    // Inbound: AI comment + human comment on p1; the agent's own reply on its
    // own post must be excluded from the received split.
    await db.insert(comments).values({ postId: p1.id, authorId: aiPeer.id, text: 'ai says' });
    await db.insert(comments).values({ postId: p1.id, authorId: human.id, text: 'human says' });
    await db.insert(comments).values({ postId: p1.id, authorId: agent.id, text: 'self reply' });
    // Inbound likes: ai on p1 and p2, human on p1 → aipeer outscores humanpal.
    await db.insert(likes).values({ userId: aiPeer.id, targetType: 'post', targetId: p1.id });
    await db.insert(likes).values({ userId: aiPeer.id, targetType: 'post', targetId: p2.id });
    await db.insert(likes).values({ userId: human.id, targetType: 'post', targetId: p1.id });

    // Outbound: one comment + one like to each species' post.
    const aiPost = await seedPost(aiPeer.id);
    const humanPost = await seedPost(human.id);
    await db.insert(comments).values({ postId: aiPost.id, authorId: agent.id, text: 'to ai' });
    await db.insert(comments).values({ postId: humanPost.id, authorId: agent.id, text: 'to hum' });
    await db.insert(likes).values({ userId: agent.id, targetType: 'post', targetId: aiPost.id });
    await db.insert(likes).values({ userId: agent.id, targetType: 'post', targetId: humanPost.id });

    const stats = await getAgentStats('statsbot', '7d');

    expect(stats.username).toBe('statsbot');
    expect(stats.range).toBe('7d');

    // Cadence: exactly 7 UTC days ending today, all-zero except today.
    expect(stats.cadence).toHaveLength(7);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayKey = today.toISOString().slice(0, 10);
    expect(stats.cadence[6].date).toBe(todayKey);
    // 2 active posts (deleted one dropped); 3 comments authored (incl. the
    // self-reply — cadence counts authorship, the split counts inbound).
    expect(stats.cadence[6]).toMatchObject({ posts: 2, comments: 3, likesGiven: 2 });
    for (const day of stats.cadence.slice(0, 6)) {
      expect(day).toMatchObject({ posts: 0, comments: 0, likesGiven: 0 });
    }

    expect(stats.engagement).toEqual({
      selfPostsReceived: {
        likes: { byAi: 2, byHuman: 1 },
        comments: { byAi: 1, byHuman: 1 },
      },
      given: {
        likes: { toAi: 1, toHuman: 1 },
        comments: { toAi: 1, toHuman: 1 },
      },
    });

    // Top interactors: aipeer 2 likes + 1 comment = 3, humanpal 1 + 1 = 2.
    expect(stats.topInteractors).toEqual([
      { username: 'aipeer', displayName: aiPeer.displayName, isAgent: true, count: 3, kind: 'in' },
      {
        username: 'humanpal',
        displayName: human.displayName,
        isAgent: false,
        count: 2,
        kind: 'in',
      },
    ]);
  });

  it('returns an all-zero cadence and empty engagement for a silent account', async () => {
    await seedUser({ username: 'hermit', isAgent: true });

    const stats = await getAgentStats('hermit', '30d');

    expect(stats.cadence).toHaveLength(30);
    expect(stats.cadence.every((d) => d.posts === 0 && d.comments === 0 && d.likesGiven === 0)).toBe(
      true,
    );
    expect(stats.engagement.selfPostsReceived.likes).toEqual({ byAi: 0, byHuman: 0 });
    expect(stats.topInteractors).toEqual([]);
  });
});

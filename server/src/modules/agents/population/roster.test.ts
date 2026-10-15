import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../db/client';
import { resetDb } from '../../../test/db-reset';
import { comments, likes, personalitySnapshots, posts, users } from '../../../db/schema';
import type { UserRow } from '../../../lib/dto';
import * as seeds from '../lab/lab.testSeeds';
import { getOverview } from './population';
import { getAgentStats, listAgents } from './roster';

/**
 * Integration suite against the real test Postgres. `listAgents`'s
 * sparkline/fidelity math is pinned by the describes at the end of this file
 * (moved from the former agents.service.test.ts); the first ones pin the
 * roster's MEMBERSHIP and cohort rules and `getAgentStats` (cadence + AI/human
 * engagement split).
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

describe('roster.listAgents era membership (S2 §6)', () => {
  async function seedPopulation() {
    // Era 3 roster accounts (first-party, live).
    await seedUser({ username: 'agen', isAgent: true, followerCount: 9 });
    await seedUser({ username: 'awen', isAgent: true, followerCount: 3 });
    // A first-party agent outside the pre-registered roster: still Era 3, no arm.
    await seedUser({ username: 'zenith', isAgent: true, followerCount: 1 });
    const owner = await seedUser({ username: 'owner1', followerCount: 0 });
    // Community (BYOA) agent: never Era 3.
    await seedUser({
      username: 'byoabot',
      isAgent: true,
      ownerId: owner.id,
      agentBackend: 'claude',
      followerCount: 5,
    });
    // A live simulated human inside the dream loop: snapshotted, not an agent.
    const liveHuman = await seedUser({ username: 'livehum', isAgent: false, followerCount: 4 });
    await seedSnapshot(liveHuman.id);
    // Sealed Era 2 accounts: one agent, one simulated human.
    const sealedAt = new Date('2026-10-14T00:00:00.000Z');
    await seedUser({ username: 'liushang', isAgent: true, archivedAt: sealedAt, followerCount: 8 });
    const sealedHuman = await seedUser({
      username: 'fenziys',
      isAgent: false,
      agentBackend: 'haiku',
      archivedAt: sealedAt,
      followerCount: 7,
    });
    await seedSnapshot(sealedHuman.id);
    await seedUser({ username: 'ghosted', isAgent: true, status: 'suspended' });
    return { sealedAt };
  }

  it('defaults to Era 3: live first-party agents only', async () => {
    await seedPopulation();

    const out = await listAgents();

    // follower desc; community, simulated humans, archived and inactive stay out.
    expect(out.map((a) => a.username)).toEqual(['agen', 'awen', 'zenith']);
    const byName = new Map(out.map((a) => [a.username, a]));
    expect(byName.get('agen')).toMatchObject({
      isAgent: true,
      cohort: 'first-party',
      arm: 'claude-opus',
      archivedAt: null,
    });
    expect(byName.get('awen')).toMatchObject({ arm: 'grok' });
    expect(byName.get('zenith')).toMatchObject({ arm: null, archivedAt: null });
    expect(byName.get('zenith')).not.toHaveProperty('agentBackend');
  });

  it('era 2 returns archived accounts only, agents and simulated humans alike', async () => {
    const { sealedAt } = await seedPopulation();

    const out = await listAgents(50, 2);

    expect(out.map((a) => a.username)).toEqual(['liushang', 'fenziys']);
    const byName = new Map(out.map((a) => [a.username, a]));
    expect(byName.get('liushang')).toMatchObject({
      cohort: 'first-party',
      arm: null,
      archivedAt: sealedAt.toISOString(),
    });
    // The lab is the analysis surface: a simulated human keeps its agentBackend.
    expect(byName.get('fenziys')).toMatchObject({
      isAgent: false,
      cohort: 'human',
      agentBackend: 'haiku',
      driftSparkline: [0],
    });
    expect(byName.get('fenziys')?.lastSnapshotAt).not.toBeNull();
  });
});

describe('roster.getAgentStats', () => {
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
    expect(
      stats.cadence.every((d) => d.posts === 0 && d.comments === 0 && d.likesGiven === 0),
    ).toBe(true);
    expect(stats.engagement.selfPostsReceived.likes).toEqual({ byAi: 0, byHuman: 0 });
    expect(stats.topInteractors).toEqual([]);
  });
});

describe('roster.listAgents', () => {
  afterEach(() => vi.restoreAllMocks());

  it('counts active posts and includes drift sparkline values', async () => {
    const agent = await seeds.seedUser({
      username: 'zenith',
      isAgent: true,
      displayName: 'Zenith',
      headline: 'Quiet observer',
      followerCount: 4,
      postCount: 12,
    });

    // 3 active posts within the last 7 days.
    await Promise.all([
      seeds.seedPost(agent.id),
      seeds.seedPost(agent.id),
      seeds.seedPost(agent.id),
    ]);

    // Three snapshots, capturedAt ascending → sparkline [0, 0.1, 0.22].
    await seeds.seedSnapshot(agent.id, {
      capturedAt: new Date('2026-06-01T00:00:00.000Z'),
      snapshotType: 'anchor',
      driftFromAnchor: 0,
    });
    await seeds.seedSnapshot(agent.id, {
      capturedAt: new Date('2026-06-02T00:00:00.000Z'),
      driftFromAnchor: 0.1,
    });
    await seeds.seedSnapshot(agent.id, {
      capturedAt: new Date('2026-06-03T00:00:00.000Z'),
      driftFromAnchor: 0.22,
    });

    await seeds.seedBehavior(agent.id, { fidelity: 0.81 });

    const out = await listAgents(10);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      username: 'zenith',
      postsLast7d: 3,
      currentDriftFromAnchor: 0.22,
      driftSparkline: [0, 0.1, 0.22],
      currentFidelity: 0.81,
    });
  });
});

describe('roster cohorts', () => {
  it('labels Era 3 list summaries first-party and leaves community and humans out', async () => {
    const owner = await seeds.seedUser({ username: 'owner1', isAgent: false });
    await seeds.seedUser({ username: 'firstparty', isAgent: true });
    await seeds.seedUser({ username: 'communitybot', isAgent: true, ownerId: owner.id });
    const labHuman = await seeds.seedUser({ username: 'labhuman', isAgent: false });
    await seeds.seedSnapshot(labHuman.id);

    const items = await listAgents();
    const cohortByName = new Map(items.map((i) => [i.username, i.cohort]));

    expect(cohortByName.get('firstparty')).toBe('first-party');
    expect(cohortByName.has('communitybot')).toBe(false);
    expect(cohortByName.has('labhuman')).toBe(false);
    expect(cohortByName.has('owner1')).toBe(false);
  });

  it('labels Era 2 list summaries first-party / human', async () => {
    const sealedAt = new Date();
    await seeds.seedUser({ username: 'sealedbot', isAgent: true, archivedAt: sealedAt });
    await seeds.seedUser({ username: 'sealedhum', isAgent: false, archivedAt: sealedAt });

    const items = await listAgents(50, 2);
    const cohortByName = new Map(items.map((i) => [i.username, i.cohort]));

    expect(cohortByName).toEqual(
      new Map([
        ['sealedbot', 'first-party'],
        ['sealedhum', 'human'],
      ]),
    );
  });

  it('overview reports cohort counts for the default (Era 3) population', async () => {
    const owner = await seeds.seedUser({ username: 'owner1', isAgent: false });
    await seeds.seedUser({ username: 'fp1', isAgent: true });
    await seeds.seedUser({ username: 'fp2', isAgent: true });
    await seeds.seedUser({ username: 'cb1', isAgent: true, ownerId: owner.id });

    const overview = await getOverview();

    expect(overview.cohorts).toEqual({ firstParty: 2, community: 0, humans: 0 });
  });
});

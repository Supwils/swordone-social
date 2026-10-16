import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/client';
import { comments, posts, users } from '../db/schema';
import { env } from '../config/env';
import type { UserRow } from './dto';
import { resetDb } from '../test/db-reset';
import { assertAgentDailyQuota, readAgentDailyUsage } from './agentQuota';

let seq = 0;
async function seedUser(over: Partial<typeof users.$inferInsert> = {}): Promise<UserRow> {
  seq += 1;
  const [u] = await db
    .insert(users)
    .values({
      username: `quota${seq}`,
      usernameDisplay: `quota${seq}`,
      email: `quota${seq}@example.com`,
      displayName: `Quota ${seq}`,
      ...over,
    })
    .returning();
  return u;
}

function postRows(authorId: string, n: number, createdAt?: Date) {
  return Array.from({ length: n }, () => ({
    authorId,
    text: 'quota filler',
    ...(createdAt ? { createdAt } : {}),
  }));
}

/**
 * A post by a separate human to hang comments on (comments.post_id is a FK).
 * Its author is not the agent under test, so it never counts toward the
 * agent's own post quota.
 */
async function seedHostPost(): Promise<string> {
  const host = await seedUser();
  const [p] = await db.insert(posts).values({ authorId: host.id, text: 'host' }).returning();
  return p.id;
}

async function commentRows(authorId: string, n: number, createdAt?: Date) {
  const postId = await seedHostPost();
  return Array.from({ length: n }, () => ({
    postId,
    authorId,
    text: 'quota filler',
    ...(createdAt ? { createdAt } : {}),
  }));
}

describe('assertAgentDailyQuota', () => {
  beforeEach(resetDb);

  it('rejects an agent that already hit the daily post limit', async () => {
    const agent = await seedUser({ isAgent: true });
    await db.insert(posts).values(postRows(agent.id, env.AGENT_DAILY_POST_LIMIT));

    await expect(assertAgentDailyQuota(agent, 'post')).rejects.toMatchObject({ status: 429 });
  });

  it('passes an agent under the daily post limit', async () => {
    const agent = await seedUser({ isAgent: true });
    await db.insert(posts).values(postRows(agent.id, env.AGENT_DAILY_POST_LIMIT - 1));

    await expect(assertAgentDailyQuota(agent, 'post')).resolves.toBeUndefined();
  });

  it('never limits humans, even at the agent limit', async () => {
    const human = await seedUser({ isAgent: false });
    await db.insert(posts).values(postRows(human.id, env.AGENT_DAILY_POST_LIMIT));

    await expect(assertAgentDailyQuota(human, 'post')).resolves.toBeUndefined();
  });

  it('does not count rows created before UTC midnight', async () => {
    const agent = await seedUser({ isAgent: true });
    const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000);
    await db.insert(posts).values(postRows(agent.id, env.AGENT_DAILY_POST_LIMIT, yesterday));

    await expect(assertAgentDailyQuota(agent, 'post')).resolves.toBeUndefined();
  });

  it('rejects an agent that already hit the daily comment limit', async () => {
    const agent = await seedUser({ isAgent: true });
    await db.insert(comments).values(await commentRows(agent.id, env.AGENT_DAILY_COMMENT_LIMIT));

    await expect(assertAgentDailyQuota(agent, 'comment')).rejects.toMatchObject({ status: 429 });
  });

  it('passes an agent under the daily comment limit', async () => {
    const agent = await seedUser({ isAgent: true });
    await db
      .insert(comments)
      .values(await commentRows(agent.id, env.AGENT_DAILY_COMMENT_LIMIT - 1));

    await expect(assertAgentDailyQuota(agent, 'comment')).resolves.toBeUndefined();
  });
});

describe('readAgentDailyUsage', () => {
  beforeEach(resetDb);

  it('counts posts and comments since UTC midnight and reports the env limits', async () => {
    const agent = await seedUser({ isAgent: true });
    await db.insert(posts).values(postRows(agent.id, 2));
    await db.insert(comments).values(await commentRows(agent.id, 5));
    const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000);
    await db.insert(posts).values(postRows(agent.id, 9, yesterday));
    await db.insert(comments).values(await commentRows(agent.id, 9, yesterday));

    await expect(readAgentDailyUsage(agent)).resolves.toEqual({
      postsToday: 2,
      postsLimit: env.AGENT_DAILY_POST_LIMIT,
      commentsToday: 5,
      commentsLimit: env.AGENT_DAILY_COMMENT_LIMIT,
    });
  });

  it('shares the UTC-midnight window that assertAgentDailyQuota uses', async () => {
    const agent = await seedUser({ isAgent: true });
    await db.insert(posts).values(postRows(agent.id, env.AGENT_DAILY_POST_LIMIT));

    const usage = await readAgentDailyUsage(agent);
    expect(usage.postsToday).toBe(env.AGENT_DAILY_POST_LIMIT);
    await expect(assertAgentDailyQuota(agent, 'post')).rejects.toMatchObject({ status: 429 });
  });
});

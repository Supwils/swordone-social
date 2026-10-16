import { describe, it, expect } from 'vitest';
import { calcFeedScore } from './feedScorer';

const HOUR = 3_600_000;

describe('calcFeedScore', () => {
  it('a brand-new zero-engagement post has score ~0.35', () => {
    const score = calcFeedScore({
      likeCount: 0,
      commentCount: 0,
      repostCount: 0,
      createdAt: new Date(),
    });
    // (0 + 0 + 0 + 1) / (0 + 2)^1.5 = 1 / 2.828... ≈ 0.3536
    expect(score).toBeCloseTo(0.354, 2);
  });

  it('older posts decay below newer zero-engagement posts of equal weight', () => {
    const fresh = calcFeedScore({
      likeCount: 0,
      commentCount: 0,
      repostCount: 0,
      createdAt: new Date(),
    });
    const day = calcFeedScore({
      likeCount: 0,
      commentCount: 0,
      repostCount: 0,
      createdAt: new Date(Date.now() - 24 * HOUR),
    });
    expect(fresh).toBeGreaterThan(day);
  });

  it('engagement weights: comment=2x like, repost=3x like', () => {
    const sameAge = new Date(Date.now() - 1 * HOUR);
    const oneLike = calcFeedScore({
      likeCount: 1,
      commentCount: 0,
      repostCount: 0,
      createdAt: sameAge,
    });
    const oneComment = calcFeedScore({
      likeCount: 0,
      commentCount: 1,
      repostCount: 0,
      createdAt: sameAge,
    });
    const oneRepost = calcFeedScore({
      likeCount: 0,
      commentCount: 0,
      repostCount: 1,
      createdAt: sameAge,
    });
    expect(oneComment).toBeGreaterThan(oneLike);
    expect(oneRepost).toBeGreaterThan(oneComment);

    // Engagement numerator: 1+1=2, 1+2=3, 1+3=4 → ratios should hold
    const denom = Math.pow(1 + 2, 1.5);
    expect(oneLike).toBeCloseTo(2 / denom, 4);
    expect(oneComment).toBeCloseTo(3 / denom, 4);
    expect(oneRepost).toBeCloseTo(4 / denom, 4);
  });

  it('engagement is not enough to overcome 24h of decay at 10 likes', () => {
    // Sanity-check on the algorithm: with the 1.5 gravity exponent, a fresh
    // empty post (0.19) still outranks a 24h post with 10 likes (0.08). To
    // beat a fresh post at 24h, you need >40 likes — confirms the algorithm
    // intentionally rewards recency strongly.
    const engaged = calcFeedScore({
      likeCount: 10,
      commentCount: 0,
      repostCount: 0,
      createdAt: new Date(Date.now() - 24 * HOUR),
    });
    const newSilent = calcFeedScore({
      likeCount: 0,
      commentCount: 0,
      repostCount: 0,
      createdAt: new Date(Date.now() - 1 * HOUR),
    });
    expect(newSilent).toBeGreaterThan(engaged);
  });

  it('high engagement (50 likes at 24h) does outrank a fresh empty post', () => {
    const heavilyEngaged = calcFeedScore({
      likeCount: 50,
      commentCount: 0,
      repostCount: 0,
      createdAt: new Date(Date.now() - 24 * HOUR),
    });
    const newSilent = calcFeedScore({
      likeCount: 0,
      commentCount: 0,
      repostCount: 0,
      createdAt: new Date(Date.now() - 1 * HOUR),
    });
    expect(heavilyEngaged).toBeGreaterThan(newSilent);
  });

  it('score monotonically decreases as a post ages with fixed engagement', () => {
    const eng = { likeCount: 5, commentCount: 2, repostCount: 1 };
    const t1 = calcFeedScore({ ...eng, createdAt: new Date(Date.now() - 1 * HOUR) });
    const t6 = calcFeedScore({ ...eng, createdAt: new Date(Date.now() - 6 * HOUR) });
    const t72 = calcFeedScore({ ...eng, createdAt: new Date(Date.now() - 72 * HOUR) });
    expect(t1).toBeGreaterThan(t6);
    expect(t6).toBeGreaterThan(t72);
  });

  it('score is always positive', () => {
    const ancient = calcFeedScore({
      likeCount: 0,
      commentCount: 0,
      repostCount: 0,
      createdAt: new Date(Date.now() - 365 * 24 * HOUR),
    });
    expect(ancient).toBeGreaterThan(0);
  });
});

describe('refreshFeedScore batching', () => {
  it('flushes queued ids after the batch window and persists real scores', async () => {
    // Dynamic imports keep this describe append-only: the file's top half is
    // a pure-function suite with no DB dependency, and should stay that way.
    const { db } = await import('../db/client');
    const { posts, users } = await import('../db/schema');
    const { resetDb } = await import('../test/db-reset');
    const { refreshFeedScore, calcFeedScore } = await import('./feedScorer');

    await resetDb();
    const [author] = await db
      .insert(users)
      .values({
        username: 'scorer1',
        usernameDisplay: 'scorer1',
        email: 'scorer1@example.com',
        displayName: 'Scorer',
      })
      .returning();
    const [p1] = await db
      .insert(posts)
      .values({ authorId: author.id, text: 'a', likeCount: 5, feedScore: 0 })
      .returning();
    const [p2] = await db
      .insert(posts)
      .values({ authorId: author.id, text: 'b', commentCount: 3, feedScore: 0 })
      .returning();

    refreshFeedScore(p1.id);
    refreshFeedScore(p2.id);
    refreshFeedScore(p1.id); // duplicate — the pending set dedupes it

    // The 2s delay IS the contract under test; the wait is event-driven on
    // the persisted value, bounded well past one batch window.
    await expect
      .poll(
        async () => {
          const rows = await db.select({ id: posts.id, feedScore: posts.feedScore }).from(posts);
          const s1 = rows.find((r) => r.id === p1.id)?.feedScore ?? 0;
          const s2 = rows.find((r) => r.id === p2.id)?.feedScore ?? 0;
          return s1 > 0 && s2 > 0;
        },
        { timeout: 8_000, interval: 250 },
      )
      .toBe(true);

    // The persisted number is the real formula, not a sentinel.
    const [row] = await db
      .select()
      .from(posts)
      .where((await import('drizzle-orm')).eq(posts.id, p1.id));
    expect(row.feedScore).toBeCloseTo(
      calcFeedScore({
        likeCount: row.likeCount,
        commentCount: row.commentCount,
        repostCount: row.repostCount,
        createdAt: row.createdAt,
      }),
      2,
    );
  }, 15_000);

  it('the periodic pass re-scores recent active posts in SQL and reports the row count', async () => {
    const { db } = await import('../db/client');
    const { posts, users } = await import('../db/schema');
    const { resetDb } = await import('../test/db-reset');
    const { eq } = await import('drizzle-orm');
    const { refreshAllFeedScores, calcFeedScore } = await import('./feedScorer');

    await resetDb();
    const [author] = await db
      .insert(users)
      .values({
        username: 'scorer2',
        usernameDisplay: 'scorer2',
        email: 'scorer2@example.com',
        displayName: 'Scorer',
      })
      .returning();
    const [fresh] = await db
      .insert(posts)
      .values({ authorId: author.id, text: 'a', likeCount: 2, feedScore: 0 })
      .returning();
    await db.insert(posts).values([
      { authorId: author.id, text: 'gone', status: 'deleted', feedScore: 0 },
      {
        authorId: author.id,
        text: 'old',
        feedScore: 0,
        createdAt: new Date(Date.now() - 40 * 24 * 3_600_000),
      },
    ]);

    expect(await refreshAllFeedScores(30)).toBe(1);
    const [row] = await db.select().from(posts).where(eq(posts.id, fresh.id));
    expect(row.feedScore).toBeCloseTo(calcFeedScore(row), 2);
  });
});

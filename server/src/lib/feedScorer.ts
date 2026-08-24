import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { posts } from '../db/schema';

/**
 * HackerNews-style gravity score.
 *
 * score = (likes + comments×2 + echos×3 + 1) / (age_hours + 2)^1.5
 *
 * - New posts start ~0.35 and naturally decay.
 * - Engagement slows decay, but gravity wins fast: a 24h-old post needs
 *   ~40+ likes to outrank a fresh zero-engagement post (verified in test).
 * - Gravity exponent 1.5 keeps content relevant for ~3-7 days before sinking.
 */
export function calcFeedScore(post: {
  likeCount: number;
  commentCount: number;
  repostCount: number;
  createdAt: Date;
}): number {
  const ageHours = (Date.now() - post.createdAt.getTime()) / 3_600_000;
  const engagement = post.likeCount + post.commentCount * 2 + post.repostCount * 3 + 1;
  return engagement / Math.pow(ageHours + 2, 1.5);
}

// Pending post IDs waiting for score refresh — deduped and flushed together.
const _pending = new Set<string>();
let _flushTimer: ReturnType<typeof setTimeout> | null = null;
const BATCH_DELAY_MS = 2_000;

function _flush(): void {
  _flushTimer = null;
  const ids = [..._pending];
  _pending.clear();
  if (!ids.length) return;
  void (async () => {
    try {
      const rows = await db
        .select({
          id: posts.id,
          likeCount: posts.likeCount,
          commentCount: posts.commentCount,
          repostCount: posts.repostCount,
          createdAt: posts.createdAt,
        })
        .from(posts)
        .where(inArray(posts.id, ids));
      await Promise.all(
        rows.map((p) =>
          db
            .update(posts)
            .set({ feedScore: calcFeedScore(p) })
            .where(inArray(posts.id, [p.id])),
        ),
      );
    } catch {
      /* fire-and-forget */
    }
  })();
}

/**
 * Re-derive every recent score from the formula above, in SQL. The event
 * path only touches posts that were just interacted with, so a post's score
 * was previously frozen at its last like — a 3-day-old post with one early
 * like sat above every fresh post forever. Bounded to a window because older
 * posts have already sunk well below anything the feed shows.
 */
export async function refreshAllFeedScores(windowDays = 30): Promise<number> {
  const since = new Date(Date.now() - windowDays * 24 * 3_600_000);
  const rows = await db
    .update(posts)
    .set({
      feedScore: sql`(${posts.likeCount} + ${posts.commentCount} * 2 + ${posts.repostCount} * 3 + 1) / power(extract(epoch from (now() - ${posts.createdAt})) / 3600.0 + 2, 1.5)`,
    })
    .where(and(eq(posts.status, 'active'), gt(posts.createdAt, since)))
    .returning({ id: posts.id });
  return rows.length;
}

const REFRESH_INTERVAL_MS = 15 * 60_000;

/** Periodic decay pass; returns a stop function. Skipped under test. */
export function startFeedScoreRefresher(intervalMs = REFRESH_INTERVAL_MS): () => void {
  const tick = () => {
    refreshAllFeedScores().catch(() => {
      /* next tick retries */
    });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Fire-and-forget score refresh — safe to call after any engagement event.
 * Calls are batched every 2 seconds to reduce DB pressure under bursts.
 */
export function refreshFeedScore(postId: string): void {
  _pending.add(postId);
  if (!_flushTimer) {
    _flushTimer = setTimeout(_flush, BATCH_DELAY_MS);
  }
}

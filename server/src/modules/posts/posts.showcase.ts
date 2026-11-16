import type { PostRow } from '../../lib/dto';
import { opensWithTime } from '../../lib/opening';

/**
 * Composition rules for the public showcase wall (the signed-out home page).
 *
 * The wall is a demonstration, not a feed: nothing here feeds the experiment,
 * no agent reads it, and the order is reshuffled on every request. It draws
 * from two pools so a visitor sees the network's range rather than only its
 * latest round:
 *
 * - **recent**: the last `RECENT_DAYS`, ranked by a softened feed score.
 * - **archive**: everything older that earned at least one reaction, ranked by
 *   engagement alone (the time decay would bury it otherwise). Sealed Era 2
 *   accounts live here and keep their "sealed" badge on the card.
 *
 * Era 3 posts open on the clock about 96% of the time (a measured result, see
 * `lib/opening.ts`), so a wall of them reads as one sentence repeated. The
 * composer caps clock openings per page; when the pools cannot fill the page
 * otherwise, it relaxes the cap instead of returning a short wall.
 */
export const SHOWCASE = {
  pageSize: 24,
  poolSize: 120,
  recentDays: 60,
  perAuthor: 2,
  /**
   * Clock-opening posts allowed on one page before the cap is relaxed. A third
   * of the page: nearly every current-era post opens this way, so a tighter
   * cap would leave the live experiment a minority on its own front page.
   */
  clockOpenings: 8,
} as const;

export interface ShowcaseCandidate {
  post: PostRow;
  score: number;
}

function engagement(p: PostRow): number {
  return p.likeCount + p.commentCount * 3 + p.repostCount * 2 + 1;
}

function imageBonus(p: PostRow): number {
  return p.images.length > 0 ? 1.5 : 1.0;
}

/** Comments weigh 3x, images 1.5x, and a soft decay lets a good week-old post stay. */
export function scoreRecent(p: PostRow, now: number): number {
  const ageHours = (now - new Date(p.createdAt).getTime()) / 3_600_000;
  return (engagement(p) * imageBonus(p)) / Math.pow(ageHours + 48, 1.1);
}

/** Older posts compete on what they earned, not on how old they are. */
export function scoreArchive(p: PostRow): number {
  return engagement(p) * imageBonus(p);
}

/**
 * Rank by score, then shuffle within thirds: the strongest posts stay near the
 * top while each refresh shows a different arrangement.
 */
export function tieredShuffle<T>(ranked: T[], random: () => number = Math.random): T[] {
  const tierSize = Math.max(1, Math.ceil(ranked.length / 3));
  const out: T[] = [];
  for (let start = 0; start < ranked.length; start += tierSize) {
    const tier = ranked.slice(start, start + tierSize);
    for (let i = tier.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [tier[i], tier[j]] = [tier[j], tier[i]];
    }
    out.push(...tier);
  }
  return out;
}

function byScore(list: ShowcaseCandidate[]): PostRow[] {
  return [...list].sort((a, b) => b.score - a.score).map((c) => c.post);
}

/**
 * Interleave the two pools (recent first), honouring the per-author cap and
 * the clock-opening budget. A post skipped only for the budget is kept aside
 * and used if the page would otherwise come up short.
 */
export function composeShowcase(
  recent: ShowcaseCandidate[],
  archive: ShowcaseCandidate[],
  random: () => number = Math.random,
): PostRow[] {
  const queues = [tieredShuffle(byScore(recent), random), tieredShuffle(byScore(archive), random)];
  const authorCount = new Map<string, number>();
  const seen = new Set<string>();
  const picked: PostRow[] = [];
  const deferred: PostRow[] = [];
  let clock = 0;

  const authorOk = (p: PostRow) => (authorCount.get(p.authorId) ?? 0) < SHOWCASE.perAuthor;
  const take = (p: PostRow) => {
    picked.push(p);
    seen.add(p.id);
    authorCount.set(p.authorId, (authorCount.get(p.authorId) ?? 0) + 1);
  };

  let turn = 0;
  while (picked.length < SHOWCASE.pageSize && queues.some((q) => q.length > 0)) {
    const queue = queues[turn % queues.length].length > 0 ? queues[turn % queues.length] : null;
    turn += 1;
    if (!queue) continue;
    const post = queue.shift()!;
    if (seen.has(post.id) || !authorOk(post)) continue;
    if (opensWithTime(post.text)) {
      if (clock >= SHOWCASE.clockOpenings) {
        deferred.push(post);
        continue;
      }
      clock += 1;
    }
    take(post);
  }

  for (const post of deferred) {
    if (picked.length >= SHOWCASE.pageSize) break;
    if (!seen.has(post.id) && authorOk(post)) take(post);
  }

  return picked;
}

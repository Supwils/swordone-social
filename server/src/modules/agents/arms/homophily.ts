/**
 * Exploratory homophily (amendment 1): directed interactions among roster
 * accounts — comment → post author, like → liked post's or comment's author,
 * echo → original post's author, follow → followee. Self excluded, any status,
 * any time (roster accounts exist only in Era 3).
 *
 * Board-mates are always in different arms and every account reads its home
 * board, so the all-edge within-arm share is structurally low. The reported
 * comparison is cross-board edges only, against the board-conditioned
 * expectation `(k − 1) / (N − 1 − (|B| − 1))`, averaged over edges.
 */
import { and, count, eq, inArray, ne } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../../../db/client';
import { comments, follows, likes, posts } from '../../../db/schema';
import { ARMS, BOARDS, type ArmId } from '../lab/roster';
import type { Homophily } from '../../../contract/lab/arms';
import { zeroByArm, type RosterUser } from './rounds';

/** `n` directed interactions from user id `source` to user id `target`. */
export interface InteractionEdge {
  source: string;
  target: string;
  n: number;
}

const ROSTER_SIZE = ARMS.reduce((sum, a) => sum + a.usernames.length, 0);
const ARM_SIZE: ReadonlyMap<ArmId, number> = new Map(ARMS.map((a) => [a.id, a.usernames.length]));
const BOARD_OF: ReadonlyMap<string, string> = new Map(
  Object.entries(BOARDS).flatMap(([board, members]) => members.map((u) => [u, board] as const)),
);
const ARM_OF: ReadonlyMap<string, ArmId> = new Map(
  ARMS.flatMap((a) => a.usernames.map((u) => [u, a.id] as const)),
);

/**
 * Chance that a cross-board edge from `username` lands in its own arm: the
 * arm's other accounts over every account off the source's board. Board-mates
 * are in other arms, so none of the k − 1 is excluded. Null off the roster.
 */
export function crossBoardExpectation(username: string): number | null {
  const arm = ARM_OF.get(username);
  const board = BOARD_OF.get(username);
  if (!arm || !board) return null;
  const boardSize = BOARDS[board].length;
  return ((ARM_SIZE.get(arm) as number) - 1) / (ROSTER_SIZE - 1 - (boardSize - 1));
}

/** Pure core of the homophily block. Edges with a non-roster end or a self loop are ignored. */
export function buildHomophily(
  roster: readonly RosterUser[],
  edges: readonly InteractionEdge[],
): Homophily {
  const byId = new Map(roster.map((u) => [u.id, u]));
  const matrix = Object.fromEntries(ARMS.map((a) => [a.id, zeroByArm()])) as Homophily['matrix'];
  const acc = new Map(
    ARMS.map((a) => [a.id, { out: 0, crossBoardOut: 0, within: 0, expectedSum: 0 }]),
  );

  for (const e of edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t || s.id === t.id || e.n <= 0) continue;
    matrix[s.arm][t.arm] += e.n;
    const row = acc.get(s.arm) as NonNullable<ReturnType<typeof acc.get>>;
    row.out += e.n;
    if (BOARD_OF.get(s.username) === BOARD_OF.get(t.username)) continue;
    row.crossBoardOut += e.n;
    if (s.arm === t.arm) row.within += e.n;
    row.expectedSum += e.n * (crossBoardExpectation(s.username) ?? 0);
  }

  return {
    matrix,
    arms: ARMS.map((a) => {
      const { out, crossBoardOut, within, expectedSum } = acc.get(a.id) as NonNullable<
        ReturnType<typeof acc.get>
      >;
      const share = crossBoardOut ? within / crossBoardOut : null;
      const expected = crossBoardOut ? expectedSum / crossBoardOut : null;
      const ratio = share !== null && expected ? share / expected : null;
      return { arm: a.id, out, crossBoardOut, within, share, expected, ratio };
    }),
  };
}

const likedPosts = alias(posts, 'liked_post');
const likedComments = alias(comments, 'liked_comment');
const origPosts = alias(posts, 'orig_post');

/**
 * Every roster → roster interaction, grouped per (source, target, kind) in
 * the database: five bounded queries whatever the corpus size.
 */
export async function loadInteractionEdges(
  roster: readonly RosterUser[],
): Promise<InteractionEdge[]> {
  const ids = roster.map((u) => u.id);
  if (ids.length === 0) return [];
  const n = count();

  const groups = await Promise.all([
    // comment → the commented post's author
    db
      .select({ source: comments.authorId, target: posts.authorId, n })
      .from(comments)
      .innerJoin(posts, eq(comments.postId, posts.id))
      .where(
        and(
          inArray(comments.authorId, ids),
          inArray(posts.authorId, ids),
          ne(comments.authorId, posts.authorId),
        ),
      )
      .groupBy(comments.authorId, posts.authorId),
    // like on a post → its author
    db
      .select({ source: likes.userId, target: likedPosts.authorId, n })
      .from(likes)
      .innerJoin(likedPosts, and(eq(likes.targetType, 'post'), eq(likes.targetId, likedPosts.id)))
      .where(
        and(
          inArray(likes.userId, ids),
          inArray(likedPosts.authorId, ids),
          ne(likes.userId, likedPosts.authorId),
        ),
      )
      .groupBy(likes.userId, likedPosts.authorId),
    // like on a comment → its author
    db
      .select({ source: likes.userId, target: likedComments.authorId, n })
      .from(likes)
      .innerJoin(
        likedComments,
        and(eq(likes.targetType, 'comment'), eq(likes.targetId, likedComments.id)),
      )
      .where(
        and(
          inArray(likes.userId, ids),
          inArray(likedComments.authorId, ids),
          ne(likes.userId, likedComments.authorId),
        ),
      )
      .groupBy(likes.userId, likedComments.authorId),
    // echo → the original post's author
    db
      .select({ source: posts.authorId, target: origPosts.authorId, n })
      .from(posts)
      .innerJoin(origPosts, eq(posts.echoOf, origPosts.id))
      .where(
        and(
          inArray(posts.authorId, ids),
          inArray(origPosts.authorId, ids),
          ne(posts.authorId, origPosts.authorId),
        ),
      )
      .groupBy(posts.authorId, origPosts.authorId),
    // follow → followee
    db
      .select({ source: follows.followerId, target: follows.followingId, n })
      .from(follows)
      .where(
        and(
          inArray(follows.followerId, ids),
          inArray(follows.followingId, ids),
          ne(follows.followerId, follows.followingId),
        ),
      )
      .groupBy(follows.followerId, follows.followingId),
  ]);
  return groups.flat();
}

export async function homophilyReport(roster: readonly RosterUser[]): Promise<Homophily> {
  return buildHomophily(roster, await loadInteractionEdges(roster));
}

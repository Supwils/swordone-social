/**
 * Agent roster: list + per-agent stats and cadence.
 *
 * Split out of the former 2018-line agents.service.ts (nine unrelated concerns,
 * six times the 300-line service ceiling). Imported directly since the S2
 * module split; there is no barrel.
 */
import { and, asc, count, desc, eq, gte, inArray, ne } from 'drizzle-orm';
import { db } from '../../../db/client';
import {
  behaviorSnapshots,
  comments,
  likes,
  personalitySnapshots,
  posts,
  users,
} from '../../../db/schema';
import { countByDay, dayBuckets, findAgentByUsername, isoDay, splitByAgent } from '../lab/shared';
import type {
  AgentStatsDTO,
  AgentSummaryDTO,
  CadencePointDTO,
} from '../../../contract/lab/population';
import type { LabCohort, LabRange } from '../../../contract/lab/era';
import { eraCondition, type LabEra } from '../lab/era';
import { armOf } from '../lab/roster';

/* ---------- list / summary ---------- */

export async function listAgents(limit = 50, era: LabEra = 3): Promise<AgentSummaryDTO[]> {
  // One era's population (S2 §6): Era 3 = live first-party agents, Era 2 =
  // every sealed account, agents and simulated humans alike. The DTO still
  // carries isAgent / cohort so the client can group the Era 2 view.
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.status, 'active'), eraCondition(era)))
    .orderBy(desc(users.followerCount), asc(users.username))
    .limit(limit);
  if (rows.length === 0) return [];

  const userIds = rows.map((u) => u.id);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [postCountRows, snapRows, behRows] = await Promise.all([
    db
      .select({ authorId: posts.authorId, n: count() })
      .from(posts)
      .where(
        and(
          inArray(posts.authorId, userIds),
          eq(posts.status, 'active'),
          gte(posts.createdAt, sevenDaysAgo),
        ),
      )
      .groupBy(posts.authorId),
    // Latest snapshot + full driftFromAnchor sparkline per user, capturedAt asc.
    db
      .select({
        userId: personalitySnapshots.userId,
        capturedAt: personalitySnapshots.capturedAt,
        driftFromAnchor: personalitySnapshots.driftFromAnchor,
      })
      .from(personalitySnapshots)
      .where(inArray(personalitySnapshots.userId, userIds))
      .orderBy(asc(personalitySnapshots.capturedAt)),
    // Latest persona fidelity per account (stated self vs revealed behavior).
    db
      .select({ userId: behaviorSnapshots.userId, fidelity: behaviorSnapshots.fidelity })
      .from(behaviorSnapshots)
      .where(inArray(behaviorSnapshots.userId, userIds))
      .orderBy(asc(behaviorSnapshots.capturedAt)),
  ]);

  const postCountById = new Map<string, number>();
  for (const r of postCountRows) postCountById.set(r.authorId, r.n);

  const fidelityById = new Map<string, number | null>();
  for (const r of behRows) {
    fidelityById.set(r.userId, typeof r.fidelity === 'number' ? r.fidelity : null);
  }

  const snapById = new Map<
    string,
    { capturedAt: Date; driftFromAnchor: number; driftSparkline: number[] }
  >();
  for (const s of snapRows) {
    const cur = snapById.get(s.userId);
    if (cur) {
      cur.capturedAt = s.capturedAt;
      cur.driftFromAnchor = s.driftFromAnchor;
      cur.driftSparkline.push(s.driftFromAnchor);
    } else {
      snapById.set(s.userId, {
        capturedAt: s.capturedAt,
        driftFromAnchor: s.driftFromAnchor,
        driftSparkline: [s.driftFromAnchor],
      });
    }
  }

  return rows.map((u) => {
    const id = u.id;
    const snap = snapById.get(id);
    return {
      id,
      username: u.username,
      displayName: u.displayName,
      headline: u.headline,
      avatarUrl: u.avatarUrl ?? null,
      ...(u.agentBackend ? { agentBackend: u.agentBackend } : {}),
      isAgent: Boolean(u.isAgent),
      archivedAt: u.archivedAt ? u.archivedAt.toISOString() : null,
      arm: armOf(u.username),
      cohort: (u.isAgent ? (u.ownerId ? 'community' : 'first-party') : 'human') as LabCohort,
      followerCount: u.followerCount,
      postCount: u.postCount,
      lastSnapshotAt: snap ? snap.capturedAt.toISOString() : null,
      currentDriftFromAnchor: snap ? snap.driftFromAnchor : null,
      driftSparkline: snap ? snap.driftSparkline.slice(-16) : [],
      postsLast7d: postCountById.get(id) ?? 0,
      currentFidelity: fidelityById.has(id) ? (fidelityById.get(id) ?? null) : null,
    };
  });
}

/* ---------- stats ---------- */

export async function getAgentStats(username: string, range: LabRange): Promise<AgentStatsDTO> {
  const agent = await findAgentByUsername(username);
  const { since } = dayBuckets(range);
  const agentId = agent.id;

  // Cadence: count posts/comments/likes-given per UTC day from `since` to today.
  const [postDates, commentDates, likeDates] = await Promise.all([
    db
      .select({ createdAt: posts.createdAt })
      .from(posts)
      .where(
        and(eq(posts.authorId, agentId), eq(posts.status, 'active'), gte(posts.createdAt, since)),
      ),
    db
      .select({ createdAt: comments.createdAt })
      .from(comments)
      .where(
        and(
          eq(comments.authorId, agentId),
          eq(comments.status, 'active'),
          gte(comments.createdAt, since),
        ),
      ),
    db
      .select({ createdAt: likes.createdAt })
      .from(likes)
      .where(and(eq(likes.userId, agentId), gte(likes.createdAt, since))),
  ]);

  const postsByDay = countByDay(postDates);
  const commentsByDay = countByDay(commentDates);
  const likesByDay = countByDay(likeDates);

  const byDay = new Map<string, CadencePointDTO>();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let d = new Date(since); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = isoDay(d);
    byDay.set(key, { date: key, posts: 0, comments: 0, likesGiven: 0 });
  }
  for (const [k, n] of postsByDay) {
    const row = byDay.get(k);
    if (row) row.posts = n;
  }
  for (const [k, n] of commentsByDay) {
    const row = byDay.get(k);
    if (row) row.comments = n;
  }
  for (const [k, n] of likesByDay) {
    const row = byDay.get(k);
    if (row) row.likesGiven = n;
  }
  const cadence = Array.from(byDay.values());

  // Engagement received: likes + comments on the agent's posts, split by actor.isAgent.
  // The join reads the actor's isAgent flag; JS reduces to an AI/human split.
  const myPostRows = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.authorId, agentId), eq(posts.status, 'active')));
  const myPostIds = myPostRows.map((p) => p.id);

  const recvLikesP: Promise<Array<{ isAgent: boolean }>> = myPostIds.length
    ? db
        .select({ isAgent: users.isAgent })
        .from(likes)
        .innerJoin(users, eq(likes.userId, users.id))
        .where(
          and(
            eq(likes.targetType, 'post'),
            inArray(likes.targetId, myPostIds),
            gte(likes.createdAt, since),
          ),
        )
    : Promise.resolve([]);
  const recvCommentsP: Promise<Array<{ isAgent: boolean }>> = myPostIds.length
    ? db
        .select({ isAgent: users.isAgent })
        .from(comments)
        .innerJoin(users, eq(comments.authorId, users.id))
        .where(
          and(
            inArray(comments.postId, myPostIds),
            ne(comments.authorId, agentId),
            eq(comments.status, 'active'),
            gte(comments.createdAt, since),
          ),
        )
    : Promise.resolve([]);
  // Comments the agent gave on OTHER people's posts, split by target-author isAgent.
  const givenCommentsP = db
    .select({ isAgent: users.isAgent })
    .from(comments)
    .innerJoin(posts, eq(comments.postId, posts.id))
    .innerJoin(users, eq(posts.authorId, users.id))
    .where(
      and(
        eq(comments.authorId, agentId),
        eq(comments.status, 'active'),
        gte(comments.createdAt, since),
        ne(posts.authorId, agentId),
      ),
    );
  // Likes given by agent split by target author.
  const likesGivenP = db
    .select({ isAgent: users.isAgent })
    .from(likes)
    .innerJoin(posts, eq(likes.targetId, posts.id))
    .innerJoin(users, eq(posts.authorId, users.id))
    .where(
      and(eq(likes.userId, agentId), eq(likes.targetType, 'post'), gte(likes.createdAt, since)),
    );
  // Top interactors: inbound likes + comments grouped by actor.
  const topLikesP: Promise<Array<{ username: string; displayName: string; isAgent: boolean }>> =
    myPostIds.length
      ? db
          .select({
            username: users.username,
            displayName: users.displayName,
            isAgent: users.isAgent,
          })
          .from(likes)
          .innerJoin(users, eq(likes.userId, users.id))
          .where(
            and(
              eq(likes.targetType, 'post'),
              inArray(likes.targetId, myPostIds),
              gte(likes.createdAt, since),
            ),
          )
      : Promise.resolve([]);
  const topCommentsP: Promise<Array<{ username: string; displayName: string; isAgent: boolean }>> =
    myPostIds.length
      ? db
          .select({
            username: users.username,
            displayName: users.displayName,
            isAgent: users.isAgent,
          })
          .from(comments)
          .innerJoin(users, eq(comments.authorId, users.id))
          .where(
            and(
              inArray(comments.postId, myPostIds),
              ne(comments.authorId, agentId),
              eq(comments.status, 'active'),
              gte(comments.createdAt, since),
            ),
          )
      : Promise.resolve([]);

  const [
    recvLikeRows,
    recvCommentRows,
    givenCommentRows,
    likesGivenRows,
    topLikeRows,
    topCommentRows,
  ] = await Promise.all([
    recvLikesP,
    recvCommentsP,
    givenCommentsP,
    likesGivenP,
    topLikesP,
    topCommentsP,
  ]);

  const likesIn = splitByAgent(recvLikeRows);
  const commentsIn = splitByAgent(recvCommentRows);
  const commentsOut = splitByAgent(givenCommentRows);
  const likesOut = splitByAgent(likesGivenRows);

  const topByUsername = new Map<
    string,
    { username: string; displayName: string; isAgent: boolean; count: number }
  >();
  const addTop = (
    interactorRows: Array<{ username: string; displayName: string; isAgent: boolean }>,
  ) => {
    for (const row of interactorRows) {
      const existing = topByUsername.get(row.username);
      if (existing) {
        existing.count += 1;
      } else {
        topByUsername.set(row.username, {
          username: row.username,
          displayName: row.displayName,
          isAgent: Boolean(row.isAgent),
          count: 1,
        });
      }
    }
  };
  addTop(topLikeRows);
  addTop(topCommentRows);
  const top = Array.from(topByUsername.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    username: agent.username,
    range,
    cadence,
    engagement: {
      selfPostsReceived: {
        likes: { byAi: likesIn.ai, byHuman: likesIn.human },
        comments: { byAi: commentsIn.ai, byHuman: commentsIn.human },
      },
      given: {
        likes: { toAi: likesOut.ai, toHuman: likesOut.human },
        comments: { toAi: commentsOut.ai, toHuman: commentsOut.human },
      },
    },
    topInteractors: top.map((row) => ({
      username: row.username,
      displayName: row.displayName,
      isAgent: row.isAgent,
      count: row.count,
      kind: 'in' as const,
    })),
  };
}

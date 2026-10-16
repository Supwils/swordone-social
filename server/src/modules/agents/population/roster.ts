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
import {
  countByDay,
  findLabAccount,
  likeOnPublicTarget,
  onPublicPost,
  splitByAgent,
} from '../lab/shared';
import { accountWindow, labWindow, windowDayKeys } from '../lab/window';
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
  // "Last 7d" is the lab's 7d window: seven UTC days ending today, or ending at
  // the seal for Era 2, so a sealed roster does not read zero forever.
  const { since: sevenDaysAgo } = await labWindow('7d', era);

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
    // Latest persona fidelity per account (stated self vs revealed behavior),
    // one row per account.
    db
      .selectDistinctOn([behaviorSnapshots.userId], {
        userId: behaviorSnapshots.userId,
        fidelity: behaviorSnapshots.fidelity,
      })
      .from(behaviorSnapshots)
      .where(inArray(behaviorSnapshots.userId, userIds))
      .orderBy(
        behaviorSnapshots.userId,
        desc(behaviorSnapshots.capturedAt),
        desc(behaviorSnapshots.id),
      ),
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
      // Deliberately NOT publicAgentBackend: the lab roster is the public
      // analysis surface and shows a sealed Era 2 simulated human's stored
      // backend (the model tier is the variable under study). Platform DTOs
      // withhold it. Decision: docs/13-observation-lab.md, 2026-10-15 entry.
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
  const agent = await findLabAccount(username);
  const window = accountWindow(range, agent);
  const { since } = window;
  const agentId = agent.id;

  // The agent's own posts, as a join target: public and live only, here and
  // below — this read is public, so it counts nothing a visitor could not
  // already see on the platform.
  const ownPublicPost = and(
    eq(posts.authorId, agentId),
    eq(posts.status, 'active'),
    eq(posts.visibility, 'public'),
  );
  const actor = {
    username: users.username,
    displayName: users.displayName,
    isAgent: users.isAgent,
  };

  const [
    postDates,
    commentDates,
    likeDates,
    likesInRows,
    commentsInRows,
    givenCommentRows,
    likesGivenRows,
  ] = await Promise.all([
    // Cadence: posts/comments/likes-given per UTC day of the window.
    db
      .select({ createdAt: posts.createdAt })
      .from(posts)
      .where(and(ownPublicPost, gte(posts.createdAt, since))),
    db
      .select({ createdAt: comments.createdAt })
      .from(comments)
      .where(
        and(
          eq(comments.authorId, agentId),
          eq(comments.status, 'active'),
          gte(comments.createdAt, since),
          onPublicPost(comments.postId),
        ),
      ),
    db
      .select({ createdAt: likes.createdAt })
      .from(likes)
      .where(and(eq(likes.userId, agentId), gte(likes.createdAt, since), likeOnPublicTarget())),
    // Engagement received, ONE query per kind: every like / comment on the
    // agent's public posts, with its actor. The AI/human split and the top
    // interactors are both derived from these rows (they used to be two
    // identical queries each, over an unbounded list of the agent's post ids).
    db
      .select(actor)
      .from(likes)
      .innerJoin(posts, eq(likes.targetId, posts.id))
      .innerJoin(users, eq(likes.userId, users.id))
      .where(and(eq(likes.targetType, 'post'), ownPublicPost, gte(likes.createdAt, since))),
    db
      .select(actor)
      .from(comments)
      .innerJoin(posts, eq(comments.postId, posts.id))
      .innerJoin(users, eq(comments.authorId, users.id))
      .where(
        and(
          ownPublicPost,
          ne(comments.authorId, agentId),
          eq(comments.status, 'active'),
          gte(comments.createdAt, since),
        ),
      ),
    // Comments the agent gave on OTHER people's posts, split by target-author isAgent.
    db
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
          eq(posts.status, 'active'),
          eq(posts.visibility, 'public'),
        ),
      ),
    // Likes given by the agent, split by target author.
    db
      .select({ isAgent: users.isAgent })
      .from(likes)
      .innerJoin(posts, eq(likes.targetId, posts.id))
      .innerJoin(users, eq(posts.authorId, users.id))
      .where(
        and(
          eq(likes.userId, agentId),
          eq(likes.targetType, 'post'),
          gte(likes.createdAt, since),
          eq(posts.status, 'active'),
          eq(posts.visibility, 'public'),
        ),
      ),
  ]);

  const postsByDay = countByDay(postDates);
  const commentsByDay = countByDay(commentDates);
  const likesByDay = countByDay(likeDates);
  const cadence: CadencePointDTO[] = windowDayKeys(window).map((date) => ({
    date,
    posts: postsByDay.get(date) ?? 0,
    comments: commentsByDay.get(date) ?? 0,
    likesGiven: likesByDay.get(date) ?? 0,
  }));

  const likesIn = splitByAgent(likesInRows);
  const commentsIn = splitByAgent(commentsInRows);
  const commentsOut = splitByAgent(givenCommentRows);
  const likesOut = splitByAgent(likesGivenRows);

  // Top interactors: inbound likes + comments grouped by actor.
  const topByUsername = new Map<
    string,
    { username: string; displayName: string; isAgent: boolean; count: number }
  >();
  for (const row of [...likesInRows, ...commentsInRows]) {
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

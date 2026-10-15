/**
 * Population-level reads: overview, cohesion, homogenization.
 *
 * Split out of the former 2018-line agents.service.ts (nine unrelated concerns,
 * six times the 300-line service ceiling). Imported directly since the S2
 * module split; there is no barrel.
 */
import { and, asc, count, eq, gte, inArray, type SQL } from 'drizzle-orm';
import { db } from '../../../db/client';
import {
  agentEvents,
  behaviorSnapshots,
  comments,
  likes,
  personalitySnapshots,
  populationMetrics,
  posts,
  users,
} from '../../../db/schema';
import { meanPairwiseCosine } from '../../../lib/vector';
import { TTLCache } from '../../../lib/ttlCache';
import type {
  AgentOverviewDTO,
  CohesionDTO,
  HomogenizationDTO,
  HomogenizationPointDTO,
} from './population.types';
import { eraCondition, type LabEra } from '../lab/era';
import { ARMS, armOf } from '../lab/roster';

/* ---------- overview ---------- */

export async function getOverview(era: LabEra = 3): Promise<AgentOverviewDTO> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const labUsers = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      isAgent: users.isAgent,
      ownerId: users.ownerId,
    })
    .from(users)
    .where(and(eq(users.status, 'active'), eraCondition(era)));
  const labIds = labUsers.map((u) => u.id);
  const cohorts = {
    firstParty: labUsers.filter((u) => u.isAgent && !u.ownerId).length,
    community: labUsers.filter((u) => u.isAgent && u.ownerId).length,
    humans: labUsers.filter((u) => !u.isAgent).length,
  };
  if (labIds.length === 0) {
    return {
      totalsToday: { posts: 0, comments: 0, likes: 0 },
      mostActive: [],
      driftLeaderboard: [],
      populationCohesion: 1,
      echoChamberFlags: [],
      cohorts,
    };
  }
  const nameById = new Map(labUsers.map((u) => [u.id, u]));

  const [totalsPosts, totalsComments, totalsLikes, postCountRows, snapRows, echoRows] =
    await Promise.all([
      db.$count(
        posts,
        and(
          inArray(posts.authorId, labIds),
          eq(posts.status, 'active'),
          gte(posts.createdAt, startOfDay),
        ),
      ),
      db.$count(
        comments,
        and(
          inArray(comments.authorId, labIds),
          eq(comments.status, 'active'),
          gte(comments.createdAt, startOfDay),
        ),
      ),
      db.$count(likes, and(inArray(likes.userId, labIds), gte(likes.createdAt, startOfDay))),
      db
        .select({ authorId: posts.authorId, n: count() })
        .from(posts)
        .where(
          and(
            inArray(posts.authorId, labIds),
            eq(posts.status, 'active'),
            gte(posts.createdAt, sevenDaysAgo),
          ),
        )
        .groupBy(posts.authorId),
      // Latest snapshot per user (capturedAt asc → last wins), incl. embedding for cohesion.
      db
        .select({
          userId: personalitySnapshots.userId,
          capturedAt: personalitySnapshots.capturedAt,
          driftFromAnchor: personalitySnapshots.driftFromAnchor,
          embedding: personalitySnapshots.embedding,
        })
        .from(personalitySnapshots)
        .where(inArray(personalitySnapshots.userId, labIds))
        .orderBy(asc(personalitySnapshots.capturedAt)),
      // echo_flag events over the last 7d; latest per user decides the flag.
      db
        .select({
          userId: agentEvents.userId,
          outcome: agentEvents.outcome,
          createdAt: agentEvents.createdAt,
        })
        .from(agentEvents)
        .where(
          and(
            inArray(agentEvents.userId, labIds),
            eq(agentEvents.type, 'echo_flag'),
            gte(agentEvents.createdAt, sevenDaysAgo),
          ),
        )
        .orderBy(asc(agentEvents.createdAt)),
    ]);

  const mostActive = [...postCountRows]
    .sort((a, b) => b.n - a.n)
    .slice(0, 5)
    .map((row) => {
      const u = nameById.get(row.authorId);
      return {
        username: u?.username ?? '?',
        displayName: u?.displayName ?? '?',
        posts: row.n,
      };
    });

  const latestByUser = new Map<string, { driftFromAnchor: number; embedding: number[] }>();
  for (const r of snapRows) {
    latestByUser.set(r.userId, { driftFromAnchor: r.driftFromAnchor, embedding: r.embedding });
  }

  const driftLeaderboardRaw = Array.from(latestByUser.entries())
    .map(([uid, s]) => {
      const u = nameById.get(uid);
      return {
        username: u?.username ?? '?',
        displayName: u?.displayName ?? '?',
        drift: s.driftFromAnchor,
        embedding: s.embedding,
      };
    })
    .sort((a, b) => b.drift - a.drift);

  const driftLeaderboard = driftLeaderboardRaw
    .slice(0, 8)
    .map(({ username, displayName, drift }) => ({
      username,
      displayName,
      drift,
    }));

  // Population cohesion: mean pairwise cosine similarity of latest snapshots.
  // Higher = agents writing about more similar things — proxy for echo-chamber
  // collapse across the whole population. Era 3 counts roster accounts only,
  // the same scope as computeCohesion.
  const cohesion = meanPairwiseCosine(
    driftLeaderboardRaw
      .filter((r) => r.embedding?.length && (era === 2 || armOf(r.username) !== null))
      .map((r) => r.embedding),
  );

  const latestEcho = new Map<string, string>();
  for (const r of echoRows) latestEcho.set(r.userId, r.outcome);
  const echoChamberFlags = Array.from(latestEcho.entries())
    .filter(([, outcome]) => outcome === 'flagged')
    .map(([uid]) => nameById.get(uid)?.username)
    .filter((username): username is string => Boolean(username));

  return {
    totalsToday: { posts: totalsPosts, comments: totalsComments, likes: totalsLikes },
    mostActive,
    driftLeaderboard,
    populationCohesion: cohesion,
    echoChamberFlags,
    cohorts,
  };
}

/* ---------- population homogenization (Feature 3) ---------- */

/** Latest embedding per user from a set of snapshot rows ordered capturedAt asc. */
function latestEmbeddings(rows: Array<{ userId: string; embedding: number[] }>): number[][] {
  const byUser = new Map<string, number[]>();
  for (const r of rows) byUser.set(r.userId, r.embedding);
  return Array.from(byUser.values()).filter((v) => v.length > 0);
}

/** Usernames of the pre-registered Era 3 roster (all five arms). */
const ROSTER_USERNAMES: string[] = ARMS.flatMap((a) => [...a.usernames]);

/**
 * Accounts a cohesion sample covers: Era 3 = roster accounts that are live Era 3
 * agents (an off-roster first-party agent would contaminate the population
 * statistic); Era 2 = every archived account.
 */
function cohesionScope(era: LabEra): SQL {
  if (era === 2) return eraCondition(2);
  return and(eraCondition(3), inArray(users.username, ROSTER_USERNAMES)) as SQL;
}

/** Live cohesion: mean pairwise cosine of the latest persona / behavior vectors. */
export async function computeCohesion(era: LabEra = 3): Promise<CohesionDTO> {
  const [personaRows, behaviorRows] = await Promise.all([
    db
      .select({
        userId: personalitySnapshots.userId,
        embedding: personalitySnapshots.embedding,
      })
      .from(personalitySnapshots)
      .innerJoin(users, eq(users.id, personalitySnapshots.userId))
      .where(cohesionScope(era))
      .orderBy(asc(personalitySnapshots.capturedAt)),
    db
      .select({ userId: behaviorSnapshots.userId, embedding: behaviorSnapshots.embedding })
      .from(behaviorSnapshots)
      .innerJoin(users, eq(users.id, behaviorSnapshots.userId))
      .where(cohesionScope(era))
      .orderBy(asc(behaviorSnapshots.capturedAt)),
  ]);
  const personaVecs = latestEmbeddings(personaRows);
  const behaviorVecs = latestEmbeddings(behaviorRows);
  return {
    personaCohesion: meanPairwiseCosine(personaVecs),
    behaviorCohesion: meanPairwiseCosine(behaviorVecs),
    // n = accounts contributing a behavior vector (the metric we most care about);
    // fall back to the persona count before any behavior vectors exist.
    n: behaviorVecs.length || personaVecs.length,
  };
}

/**
 * Compute and persist one population-cohesion sample. Only Era 3 agents call
 * this now (the cycle's population_metric node), so the sample is Era 3's.
 */
export async function recordPopulationMetric(): Promise<HomogenizationPointDTO> {
  const c = await computeCohesion(3);
  const capturedAt = new Date();
  // Don't historise a degenerate sample: with <2 behavior vectors cohesion is a
  // placeholder 1.0, which would otherwise poison the homogenization trend.
  if (c.n >= 2) {
    await db.insert(populationMetrics).values({
      capturedAt,
      personaCohesion: c.personaCohesion,
      behaviorCohesion: c.behaviorCohesion,
      n: c.n,
      era: 3,
    });
  }
  return { capturedAt: capturedAt.toISOString(), ...c };
}

/** Homogenization timeseries in range + a freshly-computed current sample. */
const homogenizationCache = new TTLCache<string, HomogenizationDTO>(60_000);
/** Test hook — the 60s TTL would otherwise replay one test's payload in the next. */
export function clearHomogenizationCache(): void {
  homogenizationCache.clear();
}
export async function getHomogenization(
  range: '7d' | '30d' | '90d' = '30d',
  era: LabEra = 3,
): Promise<HomogenizationDTO> {
  return homogenizationCache.getOrLoad(`${range}:${era}`, () => computeHomogenization(range, era));
}
async function computeHomogenization(
  range: '7d' | '30d' | '90d',
  era: LabEra,
): Promise<HomogenizationDTO> {
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await db
    .select()
    .from(populationMetrics)
    .where(and(gte(populationMetrics.capturedAt, since), eq(populationMetrics.era, era)))
    .orderBy(asc(populationMetrics.capturedAt));
  const points: HomogenizationPointDTO[] = rows.map((r) => ({
    capturedAt: r.capturedAt.toISOString(),
    personaCohesion: r.personaCohesion,
    behaviorCohesion: r.behaviorCohesion,
    n: r.n,
  }));
  const current = await computeCohesion(era);
  return { current, points };
}

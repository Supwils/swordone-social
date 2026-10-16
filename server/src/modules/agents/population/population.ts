/**
 * Population-level reads: overview, cohesion, homogenization.
 *
 * Split out of the former 2018-line agents.service.ts (nine unrelated concerns,
 * six times the 300-line service ceiling). Imported directly since the S2
 * module split; there is no barrel.
 */
import type { LabRange } from '../../../contract/lab/era';
import { and, asc, count, desc, eq, gte, inArray, type SQL } from 'drizzle-orm';
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
} from '../../../contract/lab/population';
import { eraCondition, type LabEra } from '../lab/era';
import { ROSTER_USERNAMES, armOf } from '../lab/roster';
import { labWindow } from '../lab/window';

/* ---------- overview ---------- */

/**
 * Cached like every other population read: this one used to recompute on every
 * request, loading every persona snapshot WITH its 1024-float embedding.
 */
const overviewCache = new TTLCache<LabEra, AgentOverviewDTO>(60_000);
/** Test hook — the 60s TTL would otherwise replay one test's payload in the next. */
export function clearOverviewCache(): void {
  overviewCache.clear();
}
export async function getOverview(era: LabEra = 3): Promise<AgentOverviewDTO> {
  return overviewCache.getOrLoad(era, () => computeOverview(era));
}

async function computeOverview(era: LabEra): Promise<AgentOverviewDTO> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  // The lab's 7d window (ends at the seal for Era 2). `totalsToday` stays the
  // literal UTC today: it is a "what is happening now" number, 0 for a sealed era.
  const { since: sevenDaysAgo } = await labWindow('7d', era);

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
  // Three cohorts for both eras' DTO shape. Era 3's population is first-party
  // agents by definition (`eraCondition(3)`), so `community` and `humans` are
  // always 0 there; Era 2 has humans (its simulated ones) and no community.
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
      // Latest snapshot per user, one row each, incl. embedding for cohesion.
      latestPersonaRows(inArray(personalitySnapshots.userId, labIds)),
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

  const driftLeaderboardRaw = snapRows
    .map((s) => {
      const u = nameById.get(s.userId);
      return {
        username: u?.username ?? '?',
        displayName: u?.displayName ?? '?',
        drift: s.driftFromAnchor,
        embedding: s.embedding,
      };
    })
    // Equal drift (every account at 0 right after registration) breaks by username,
    // so the top 8 are a stable set rather than whichever rows came back first.
    .sort((a, b) => b.drift - a.drift || a.username.localeCompare(b.username));

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
  // the same scope as computeCohesion. The drift leaderboard above deliberately
  // does NOT narrow to the roster: an off-roster first-party agent is still
  // worth seeing there, it just must not enter the population statistic.
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

/**
 * The latest persona snapshot per user matching `where` — ONE row per user
 * (`DISTINCT ON`), instead of every snapshot ever filed with its embedding and
 * a "last one wins" pass in JS. Ties on `captured_at` break by id.
 */
function latestPersonaRows(where: SQL | undefined) {
  return db
    .selectDistinctOn([personalitySnapshots.userId], {
      userId: personalitySnapshots.userId,
      driftFromAnchor: personalitySnapshots.driftFromAnchor,
      embedding: personalitySnapshots.embedding,
    })
    .from(personalitySnapshots)
    .innerJoin(users, eq(users.id, personalitySnapshots.userId))
    .where(where)
    .orderBy(
      personalitySnapshots.userId,
      desc(personalitySnapshots.capturedAt),
      desc(personalitySnapshots.id),
    );
}

/** The latest behavior embedding per user in `scope` — one row per user. */
function latestBehaviorRows(where: SQL | undefined) {
  return db
    .selectDistinctOn([behaviorSnapshots.userId], {
      userId: behaviorSnapshots.userId,
      embedding: behaviorSnapshots.embedding,
    })
    .from(behaviorSnapshots)
    .innerJoin(users, eq(users.id, behaviorSnapshots.userId))
    .where(where)
    .orderBy(
      behaviorSnapshots.userId,
      desc(behaviorSnapshots.capturedAt),
      desc(behaviorSnapshots.id),
    );
}

const nonEmpty = (rows: Array<{ embedding: number[] }>): number[][] =>
  rows.map((r) => r.embedding).filter((v) => v.length > 0);

/**
 * Accounts a cohesion sample covers: Era 3 = roster accounts that are live Era 3
 * agents (an off-roster first-party agent would contaminate the population
 * statistic); Era 2 = every archived account.
 */
function cohesionScope(era: LabEra): SQL {
  if (era === 2) return eraCondition(2);
  return and(eraCondition(3), inArray(users.username, [...ROSTER_USERNAMES])) as SQL;
}

interface CohesionSample {
  dto: CohesionDTO;
  /** Accounts contributing a persona vector / a behavior vector. */
  personaN: number;
  behaviorN: number;
}

async function sampleCohesion(era: LabEra): Promise<CohesionSample> {
  const [personaRows, behaviorRows] = await Promise.all([
    latestPersonaRows(cohesionScope(era)),
    latestBehaviorRows(cohesionScope(era)),
  ]);
  const personaVecs = nonEmpty(personaRows);
  const behaviorVecs = nonEmpty(behaviorRows);
  return {
    dto: {
      personaCohesion: meanPairwiseCosine(personaVecs),
      behaviorCohesion: meanPairwiseCosine(behaviorVecs),
      // n = accounts contributing a behavior vector (the metric we most care about);
      // fall back to the persona count before any behavior vectors exist.
      n: behaviorVecs.length || personaVecs.length,
    },
    personaN: personaVecs.length,
    behaviorN: behaviorVecs.length,
  };
}

/** Live cohesion: mean pairwise cosine of the latest persona / behavior vectors. */
export async function computeCohesion(era: LabEra = 3): Promise<CohesionDTO> {
  return (await sampleCohesion(era)).dto;
}

/**
 * Compute and persist one population-cohesion sample. Only Era 3 agents call
 * this now (the cycle's population_metric node), so the sample is Era 3's.
 */
export async function recordPopulationMetric(): Promise<HomogenizationPointDTO> {
  const { dto: c, behaviorN } = await sampleCohesion(3);
  const capturedAt = new Date();
  // Don't historise a degenerate sample. With < 2 behavior vectors
  // `behaviorCohesion` is the placeholder 1.0 ("fully homogenised"), and the
  // guard used to read `n`, which falls back to the persona count — so at Era 3
  // launch (20 anchors, no behavior vectors yet) and whenever the embedder was
  // down, round 1 wrote 1.0 into the series. The gate is the behavior count.
  if (behaviorN >= 2) {
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
  range: LabRange = '30d',
  era: LabEra = 3,
): Promise<HomogenizationDTO> {
  return homogenizationCache.getOrLoad(`${range}:${era}`, () => computeHomogenization(range, era));
}
async function computeHomogenization(range: LabRange, era: LabEra): Promise<HomogenizationDTO> {
  const { since } = await labWindow(range, era);
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

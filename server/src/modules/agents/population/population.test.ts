import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../db/client';
import { resetDb } from '../../../test/db-reset';
import {
  behaviorSnapshots,
  personalitySnapshots,
  populationMetrics,
  users,
} from '../../../db/schema';
import {
  clearHomogenizationCache,
  clearOverviewCache,
  computeCohesion,
  getHomogenization,
  getOverview,
  recordPopulationMetric,
} from './population';
import * as seeds from '../lab/lab.testSeeds';

async function seedAgent(
  username: string,
  archivedAt: Date | null,
  over: Partial<typeof users.$inferInsert> = {},
): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      username,
      usernameDisplay: username,
      email: `${username}@example.test`,
      displayName: username,
      isAgent: true,
      archivedAt,
      ...over,
    })
    .returning();
  return u.id;
}

function vec(...head: number[]): number[] {
  return [...head, ...new Array<number>(1024 - head.length).fill(0)];
}

async function seedSnapshot(userId: string, embedding: number[], hash: string): Promise<void> {
  await db.insert(personalitySnapshots).values({
    userId,
    capturedAt: new Date(),
    contentHash: hash,
    embedding,
    archivePath: 'x',
  });
}

async function seedBehavior(userId: string, embedding: number[], hash: string): Promise<void> {
  await db.insert(behaviorSnapshots).values({
    userId,
    capturedAt: new Date(),
    contentHash: hash,
    embedding,
  });
}

describe('computeCohesion', () => {
  beforeEach(async () => {
    await resetDb();
    clearOverviewCache();
  });

  it('Era 3 covers roster accounts only — not archived users, not off-roster agents', async () => {
    const a = await seedAgent('agen', null);
    const b = await seedAgent('awen', null);
    const sealed = await seedAgent('sealed_c', new Date());
    const offRoster = await seedAgent('zenith', null);
    await seedSnapshot(a, vec(1, 0), 'h1');
    await seedSnapshot(b, vec(1, 0), 'h2');
    // Orthogonal to the roster pair: either would drag cohesion below 1 if counted.
    await seedSnapshot(sealed, vec(0, 1), 'h3');
    await seedSnapshot(offRoster, vec(0, 1), 'h4');

    const c = await computeCohesion(3);

    expect(c.personaCohesion).toBeCloseTo(1, 5);
    expect(c.n).toBe(2);
  });

  it('Era 2 covers archived users only', async () => {
    const live = await seedAgent('agen', null);
    const s1 = await seedAgent('sealed_a', new Date());
    const s2 = await seedAgent('sealed_b', new Date(), { isAgent: false });
    await seedSnapshot(live, vec(1, 0), 'h1');
    await seedSnapshot(s1, vec(0, 1), 'h2');
    await seedSnapshot(s2, vec(0, 1), 'h3');

    const c = await computeCohesion(2);

    expect(c.personaCohesion).toBeCloseTo(1, 5);
    expect(c.n).toBe(2);
  });
});

describe('recordPopulationMetric', () => {
  beforeEach(async () => {
    await resetDb();
    clearOverviewCache();
  });

  it('stores no row from persona vectors alone: 2 persona + 0 behavior is a placeholder 1.0', async () => {
    // Era 3 launch: every roster account has its anchor, none has a behavior
    // snapshot yet. The guard used to read `n`, which falls back to the persona
    // count, so this stored behaviorCohesion = 1 ("fully homogenised").
    const a = await seedAgent('agen', null);
    const b = await seedAgent('awen', null);
    await seedSnapshot(a, vec(1, 0), 'h1');
    await seedSnapshot(b, vec(0, 1), 'h2');

    const point = await recordPopulationMetric();

    expect(point.n).toBe(2); // the response still reports the live sample
    expect(await db.select().from(populationMetrics)).toHaveLength(0);
  });

  it('stores no row from a single behavior vector', async () => {
    const a = await seedAgent('agen', null);
    const b = await seedAgent('awen', null);
    await seedSnapshot(a, vec(1, 0), 'h1');
    await seedSnapshot(b, vec(1, 0), 'h2');
    await seedBehavior(a, vec(1, 0), 'b1');

    await recordPopulationMetric();

    expect(await db.select().from(populationMetrics)).toHaveLength(0);
  });

  it('stores an Era 3 row with n = 2 once two roster accounts have behavior vectors', async () => {
    const a = await seedAgent('agen', null);
    const b = await seedAgent('awen', null);
    await seedSnapshot(a, vec(1, 0), 'h1');
    await seedSnapshot(b, vec(1, 0), 'h2');
    await seedBehavior(a, vec(1, 0), 'b1');
    await seedBehavior(b, vec(0, 1), 'b2');

    const point = await recordPopulationMetric();

    expect(point.n).toBe(2);
    const rows = await db.select().from(populationMetrics);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ era: 3, n: 2 });
    expect(rows[0].personaCohesion).toBeCloseTo(1, 5);
    expect(rows[0].behaviorCohesion).toBeCloseTo(0, 5);
  });
});

describe('getHomogenization era scoping', () => {
  beforeEach(async () => {
    await resetDb();
    clearHomogenizationCache();
  });

  it('returns only the requested era’s history, never one era’s cached payload for the other', async () => {
    const day = 24 * 60 * 60 * 1000;
    await db.insert(populationMetrics).values([
      {
        capturedAt: new Date(Date.now() - 2 * day),
        personaCohesion: 0.5,
        behaviorCohesion: 0.4,
        n: 4,
        era: 2,
      },
      {
        capturedAt: new Date(Date.now() - day),
        personaCohesion: 0.9,
        behaviorCohesion: 0.8,
        n: 20,
        era: 3,
      },
    ]);

    const era3 = await getHomogenization('7d', 3);
    const era2 = await getHomogenization('7d', 2);

    expect(era3.points.map((p) => p.n)).toEqual([20]);
    expect(era2.points.map((p) => p.n)).toEqual([4]);
  });
});

describe('getOverview era scoping', () => {
  beforeEach(async () => {
    await resetDb();
    clearOverviewCache();
  });

  it('caches the overview per era for 60 s (it used to recompute on every request)', async () => {
    await seedAgent('agen', null);
    const first = await getOverview(3);
    expect(first.cohorts.firstParty).toBe(1);

    await seedAgent('awen', null);
    expect(await getOverview(3)).toBe(first); // served from the cache
    expect((await getOverview(2)).cohorts.firstParty).toBe(0); // its own key

    clearOverviewCache();
    expect((await getOverview(3)).cohorts.firstParty).toBe(2);
  });

  it('Era 3 counts live first-party agents; Era 2 counts archived agents and humans', async () => {
    const [owner] = await db
      .insert(users)
      .values({
        username: 'owner1',
        usernameDisplay: 'owner1',
        email: 'o@example.test',
        displayName: 'o',
      })
      .returning();
    await seedAgent('agen', null);
    await seedAgent('awen', null);
    await seedAgent('byoabot', null, { ownerId: owner.id });
    await seedAgent('sealed_a', new Date());
    await seedAgent('sealed_h', new Date(), { isAgent: false });

    const era3 = await getOverview(3);
    const era2 = await getOverview(2);

    expect(era3.cohorts).toEqual({ firstParty: 2, community: 0, humans: 0 });
    expect(era2.cohorts).toEqual({ firstParty: 1, community: 0, humans: 1 });
  });

  it('Era 3 overview cohesion ignores an off-roster first-party agent', async () => {
    const a = await seedAgent('agen', null);
    const b = await seedAgent('awen', null);
    const offRoster = await seedAgent('zenith', null);
    await seedSnapshot(a, vec(1, 0), 'h1');
    await seedSnapshot(b, vec(1, 0), 'h2');
    await seedSnapshot(offRoster, vec(0, 1), 'h3');

    const overview = await getOverview(3);

    // zenith is still an Era 3 account (it shows on the leaderboard)...
    expect(overview.driftLeaderboard.map((d) => d.username).sort()).toEqual([
      'agen',
      'awen',
      'zenith',
    ]);
    // ...but the population statistic is the pre-registered roster's.
    expect(overview.populationCohesion).toBeCloseTo(1, 5);
  });
});

describe('population homogenization', () => {
  beforeEach(async () => {
    await resetDb();
    clearHomogenizationCache();
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns stored points plus a freshly-computed current cohesion', async () => {
    // One stored metric within the 30d window.
    await db.insert(populationMetrics).values({
      capturedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      personaCohesion: 0.82,
      behaviorCohesion: 0.7,
      n: 5,
      era: 3,
    });

    // current: persona vectors identical → cohesion 1; behavior orthogonal → 0
    const u1 = await seeds.seedUser({ username: 'agen', isAgent: true });
    const u2 = await seeds.seedUser({ username: 'awen', isAgent: true });
    await seeds.seedSnapshot(u1.id, { embedding: seeds.axis(0) });
    await seeds.seedSnapshot(u2.id, { embedding: seeds.axis(0) });
    await seeds.seedBehavior(u1.id, { embedding: seeds.axis(0) });
    await seeds.seedBehavior(u2.id, { embedding: seeds.axis(1) });

    const out = await getHomogenization('30d');
    expect(out.points).toHaveLength(1);
    expect(out.current.personaCohesion).toBeCloseTo(1);
    expect(out.current.behaviorCohesion).toBeCloseTo(0);
    expect(out.current.n).toBe(2);
  });
});

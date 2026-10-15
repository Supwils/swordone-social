import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHash, randomBytes } from 'crypto';
import { z } from 'zod';
import { createApp } from '../../app';
import { db } from '../../db/client';
import { agentEvents, apiKeys, comments, likes, posts, users } from '../../db/schema';
import { resetDb } from '../../test/db-reset';
import { envelopeData, expectContract } from '../../test/contract';
import { axis, mixed06 } from './lab/lab.testSeeds';
import {
  AgentEventIngestResultSchema,
  BehaviorSnapshotIngestResultSchema,
  IngestIdResultSchema,
  SnapshotIngestResultSchema,
} from '../../contract/ingest';
import {
  AgentOverviewDTOSchema,
  AgentStatsDTOSchema,
  AgentSummaryDTOSchema,
  AlertsDTOSchema,
  AnomalyAlertDTOSchema,
  CadencePointDTOSchema,
  CohesionDTOSchema,
  GraphEdgeDTOSchema,
  GraphNodeDTOSchema,
  HomogenizationDTOSchema,
  HomogenizationPointDTOSchema,
  InfluencePartnerDTOSchema,
  InfluencesDTOSchema,
  InteractionGraphDTOSchema,
  PulseDTOSchema,
  PulsePointDTOSchema,
} from '../../contract/lab/population';
import {
  DriftPointDTOSchema,
  FidelityDTOSchema,
  FidelityPointDTOSchema,
} from '../../contract/lab/persona';
import {
  AgentEventDTOSchema,
  RuntimeHealthDTOSchema,
  RuntimeHealthPointDTOSchema,
} from '../../contract/lab/runtime';
import {
  BenchmarkCompareDTOSchema,
  BenchmarkCompareItemDTOSchema,
  BenchmarkLeaderboardDTOSchema,
  BenchmarkLeaderboardRowDTOSchema,
  BenchmarkMatrixCellDTOSchema,
  BenchmarkMatrixDTOSchema,
} from '../../contract/lab/bench';

/**
 * Every lab read and every agent ingest over the real HTTP stack, each
 * serialised body parsed through the envelope and its strict contract schema
 * (spec §3.2, §7.8). The world is built once, mostly THROUGH the ingest
 * endpoints, so the reads see rows the way the agent writes them; every list
 * the schemas describe is asserted non-empty, so an item schema is never
 * checked against `[]` alone. The arms report, `/:u/rounds`, the drift
 * countdown and the collapse watch are parsed in their own suites
 * (`arms/report.test.ts`, `arms/accountRounds.test.ts`,
 * `persona/countdown.test.ts`, `persona/collapse.test.ts`).
 */

const DAY = 24 * 60 * 60 * 1000;
const ROUND = '20261014T060000Z-r';
const hex = (c: string) => c.repeat(64);

interface World {
  agenKey: string;
  xiaoyuKey: string;
  agenPostId: string;
  ingest: Record<string, request.Response>;
}

let world: World;

async function seedAccount(username: string, over: Partial<typeof users.$inferInsert> = {}) {
  const [user] = await db
    .insert(users)
    .values({
      username,
      usernameDisplay: username,
      email: `${username}@example.test`,
      displayName: username.toUpperCase(),
      ...over,
    })
    .returning();
  const key = `sk-swil-${randomBytes(8).toString('hex')}`;
  await db.insert(apiKeys).values({
    userId: user.id,
    name: 'test',
    keyHash: createHash('sha256').update(key).digest('hex'),
  });
  return { user, key };
}

function post(path: string, key: string, body?: object) {
  const req = request(createApp())
    .post(`/api/v1/agents${path}`)
    .set('Authorization', `Bearer ${key}`);
  return body === undefined ? req.send() : req.send(body);
}

async function get(path: string) {
  const res = await request(createApp()).get(`/api/v1/agents${path}`);
  expect(res.status).toBe(200);
  return res.body as unknown;
}

/** `{ <key>: [...] }` around a list, strictly; returns the list for item-level parsing. */
function listOf(body: unknown, key: string): unknown[] {
  const data = expectContract(
    z.object({ [key]: z.array(z.unknown()) }).strict(),
    envelopeData(body),
  );
  return data[key];
}

async function seedWorld(): Promise<World> {
  const agen = await seedAccount('agen', {
    isAgent: true,
    agentBackend: 'claude:claude-opus-5-5',
    headline: 'roster account',
  });
  const xiaoyu = await seedAccount('xiaoyu', { isAgent: true });
  const human = await seedAccount('hum1', { isAgent: false });
  const now = Date.now();
  const ingest: Record<string, request.Response> = {};

  // Personality snapshots: an anchor, then a dream that jumps a whole axis
  // (driftFromPrev 1 → a drift_spike alert) carrying the Era 2 aspect block.
  ingest.anchor = await post('/agen/snapshots', agen.key, {
    contentHash: hex('a'),
    embedding: axis(0),
    snapshotType: 'anchor',
    capturedAt: new Date(now - 3 * DAY).toISOString(),
    archivePath: 'agents/agen/personality.md',
    excerpt: 'anchor',
  });
  ingest.dream = await post('/agen/snapshots', agen.key, {
    contentHash: hex('b'),
    embedding: axis(1),
    capturedAt: new Date(now - DAY).toISOString(),
    archivePath: 'agents/agen/personality.archive.md',
    excerpt: 'dreamt',
    diffNarrative: 'moved on',
    aspectDrift: {
      mode: 'shadow',
      promptVersion: 1,
      values: 0.9,
      style: 0.4,
      topic: 0.7,
      breached: ['style'],
    },
  });
  await post('/xiaoyu/snapshots', xiaoyu.key, {
    contentHash: hex('c'),
    embedding: mixed06(),
    snapshotType: 'anchor',
    capturedAt: new Date(now - 2 * DAY).toISOString(),
    archivePath: 'agents/xiaoyu/personality.md',
  });

  // Behavior snapshots: agen's is orthogonal to its persona (fidelity 0 →
  // low_fidelity), xiaoyu's matches (fidelity 1). Two vectors → a cohesion sample.
  ingest.behavior = await post('/agen/behavior-snapshots', agen.key, {
    contentHash: hex('d'),
    embedding: axis(0),
    postCount: 2,
    commentCount: 1,
    excerpt: 'recent posts',
  });
  await post('/xiaoyu/behavior-snapshots', xiaoyu.key, {
    contentHash: hex('e'),
    embedding: mixed06(),
  });
  ingest.population = await post('/population-metric', agen.key);

  // The social graph: posts, a comment and a reply, an echo, likes, across
  // two agents and a human.
  const [agenPost] = await db
    .insert(posts)
    .values({ authorId: agen.user.id, text: 'agen speaks' })
    .returning();
  const [xiaoyuPost] = await db
    .insert(posts)
    .values({ authorId: xiaoyu.user.id, text: 'xiaoyu speaks' })
    .returning();
  await db.insert(posts).values({ authorId: xiaoyu.user.id, text: '', echoOf: agenPost.id });
  const [top] = await db
    .insert(comments)
    .values({ postId: xiaoyuPost.id, authorId: agen.user.id, text: 'agreed' })
    .returning();
  await db
    .insert(comments)
    .values({ postId: xiaoyuPost.id, authorId: xiaoyu.user.id, text: 'thanks', parentId: top.id });
  await db.insert(comments).values({ postId: agenPost.id, authorId: human.user.id, text: 'hi' });
  await db.insert(likes).values([
    { userId: agen.user.id, targetType: 'post', targetId: xiaoyuPost.id },
    { userId: human.user.id, targetType: 'post', targetId: agenPost.id },
  ]);

  // Lab events: an act event with every optional field, a cycle_run card for
  // the runtime strip, two failed dreams, an echo flag and a rule flag.
  ingest.event = await post('/agen/events', agen.key, {
    type: 'cycle',
    phase: 'act',
    outcome: 'success',
    action: 'comment',
    summary: '→@xiaoyu',
    reason: 'replied to a friend',
    targetId: xiaoyuPost.id,
    metrics: { roundId: ROUND, maxSim: 0.3, dropped: false, note: null },
  });
  await post('/agen/events', agen.key, {
    type: 'cycle',
    phase: 'act',
    outcome: 'warn',
    summary: 'cycle_run agen landed_all',
    metrics: {
      kind: 'cycle_run',
      roundId: ROUND,
      attempted: 1,
      landed: 1,
      missingBehaviorSnapshot: true,
      missingPostVector: true,
    },
  });
  for (const summary of ['dream fail 1', 'dream fail 2']) {
    await post('/agen/events', agen.key, {
      type: 'dream',
      phase: 'dream',
      outcome: 'fail',
      summary,
    });
  }
  await post('/xiaoyu/events', xiaoyu.key, {
    type: 'echo_flag',
    phase: 'echo',
    outcome: 'flagged',
    summary: 'low variance',
  });
  await post('/xiaoyu/events', xiaoyu.key, {
    type: 'rule_check',
    phase: 'rule',
    outcome: 'flagged',
    summary: 'hashtag rule 1/4',
  });

  ingest.postVector = await post('/agen/post-vectors', agen.key, {
    postId: agenPost.id,
    roundId: ROUND,
    embedding: axis(2),
    cardSim: 0.7,
    maxSim: 0.3,
  });

  // Persona Bench: two models, one run each, on one task.
  ingest.bench = await post('/benchmark/runs', agen.key, {
    batchId: 'b1',
    persona: 'agen',
    personaDisplay: 'Agen',
    model: 'opus',
    taskId: 'free_post',
    taskKind: 'post',
    runIndex: 0,
    output: 'a post in character',
    vectorFidelity: 0.8,
    judgeScore: 70,
    ruleScore: 1,
    ruleDetail: 'ok',
    latencyMs: 1200,
  });
  await post('/benchmark/runs', agen.key, {
    batchId: 'b1',
    persona: 'agen',
    model: 'haiku',
    taskId: 'free_post',
  });

  // Era 2 (sealed): an archived agent with two failed dreams (→ dream_rejected)
  // and an archived simulated human (isAgent false, outside the roster). Rows
  // go in directly: sealed accounts cannot write lab events.
  const sealedAt = new Date(now - 10 * DAY);
  const { user: sealed } = await seedAccount('liushang', { isAgent: true, archivedAt: sealedAt });
  await seedAccount('simhum', {
    isAgent: false,
    archivedAt: sealedAt,
    agentBackend: 'claude:claude-haiku-5-5',
  });
  for (const summary of ['dream rejected 1', 'dream rejected 2']) {
    await db.insert(agentEvents).values({
      userId: sealed.id,
      type: 'dream',
      phase: 'dream',
      outcome: 'fail',
      summary,
    });
  }

  return { agenKey: agen.key, xiaoyuKey: xiaoyu.key, agenPostId: agenPost.id, ingest };
}

beforeAll(async () => {
  await resetDb();
  world = await seedWorld();
}, 30_000);

describe('ingest response bodies', () => {
  it('snapshot ingest → 201 { id, driftFromAnchor, driftFromPrev }', () => {
    for (const res of [world.ingest.anchor, world.ingest.dream]) {
      expect(res.status).toBe(201);
      expectContract(SnapshotIngestResultSchema, envelopeData(res.body));
    }
    expect(world.ingest.dream.body.data.driftFromPrev).toBeCloseTo(1, 9);
  });

  it('behavior snapshot ingest → 201 { id, fidelity }', () => {
    expect(world.ingest.behavior.status).toBe(201);
    const out = expectContract(
      BehaviorSnapshotIngestResultSchema,
      envelopeData(world.ingest.behavior.body),
    );
    expect(out.fidelity).toBeCloseTo(0, 9);
  });

  it('population metric (no body) → 201 HomogenizationPointDTO', () => {
    expect(world.ingest.population.status).toBe(201);
    const out = expectContract(
      HomogenizationPointDTOSchema,
      envelopeData(world.ingest.population.body),
    );
    expect(out.n).toBe(2);
  });

  it('lab event ingest → 201 { event } with every optional field present', () => {
    expect(world.ingest.event.status).toBe(201);
    const { event } = expectContract(
      AgentEventIngestResultSchema,
      envelopeData(world.ingest.event.body),
    );
    expect(event).toMatchObject({ action: 'comment', reason: 'replied to a friend' });
  });

  it('post vector ingest → 201 { id }, and the replay → 200 with the same { id }', async () => {
    expect(world.ingest.postVector.status).toBe(201);
    const first = expectContract(IngestIdResultSchema, envelopeData(world.ingest.postVector.body));
    const replay = await post('/agen/post-vectors', world.agenKey, {
      postId: world.agenPostId,
      roundId: null,
      embedding: axis(2),
      cardSim: null,
      maxSim: null,
    });
    expect(replay.status).toBe(200);
    expect(expectContract(IngestIdResultSchema, envelopeData(replay.body))).toEqual(first);
  });

  it('benchmark run ingest → 201 { id }', () => {
    expect(world.ingest.bench.status).toBe(201);
    expectContract(IngestIdResultSchema, envelopeData(world.ingest.bench.body));
  });
});

describe('population read bodies', () => {
  it('GET /agents → { items: AgentSummaryDTO[] } (with and without agentBackend)', async () => {
    const items = listOf(await get(''), 'items');
    expect(items).toHaveLength(2);
    const parsed = items.map((i) => expectContract(AgentSummaryDTOSchema, i));
    expect(parsed.find((p) => p.username === 'agen')).toMatchObject({
      agentBackend: 'claude:claude-opus-5-5',
      arm: 'claude-opus',
      cohort: 'first-party',
    });
    expect(parsed.find((p) => p.username === 'agen')?.driftSparkline.length).toBeGreaterThan(0);
  });

  it('GET /agents/:u/stats → AgentStatsDTO', async () => {
    const out = expectContract(
      AgentStatsDTOSchema,
      envelopeData(await get('/agen/stats?range=7d')),
    );
    expect(out.cadence.length).toBeGreaterThan(0);
    expectContract(CadencePointDTOSchema, out.cadence[0]);
    expect(out.topInteractors.length).toBeGreaterThan(0);
  });

  it('GET /agents/overview → AgentOverviewDTO', async () => {
    const out = expectContract(AgentOverviewDTOSchema, envelopeData(await get('/overview')));
    expect(out.mostActive.length).toBeGreaterThan(0);
    expect(out.driftLeaderboard.length).toBeGreaterThan(0);
  });

  it('GET /agents/graph → InteractionGraphDTO', async () => {
    const out = expectContract(InteractionGraphDTOSchema, envelopeData(await get('/graph')));
    expect(out.nodes.length).toBeGreaterThan(0);
    expect(out.edges.length).toBeGreaterThan(0);
    expectContract(GraphNodeDTOSchema, out.nodes[0]);
    expectContract(GraphEdgeDTOSchema, out.edges[0]);
  });

  it('GET /agents/homogenization → HomogenizationDTO', async () => {
    const out = expectContract(HomogenizationDTOSchema, envelopeData(await get('/homogenization')));
    expectContract(CohesionDTOSchema, out.current);
    expect(out.points.length).toBeGreaterThan(0);
    expectContract(HomogenizationPointDTOSchema, out.points[0]);
  });

  it('GET /agents/pulse → PulseDTO', async () => {
    const out = expectContract(PulseDTOSchema, envelopeData(await get('/pulse?range=7d')));
    expect(out.points.length).toBeGreaterThan(0);
    for (const p of out.points) expectContract(PulsePointDTOSchema, p);
    expect(out.points.some((p) => p.meanFidelity !== null)).toBe(true);
  });

  it('GET /agents/alerts → AlertsDTO with every Era 3 alert kind the world provokes', async () => {
    const out = expectContract(AlertsDTOSchema, envelopeData(await get('/alerts')));
    for (const a of out.alerts) expectContract(AnomalyAlertDTOSchema, a);
    expect(new Set(out.alerts.map((a) => a.kind))).toEqual(
      new Set(['drift_spike', 'low_fidelity', 'dream_failed', 'echo_chamber', 'rule_violation']),
    );
  });

  it('GET /agents/:u/influences → InfluencesDTO', async () => {
    const out = expectContract(InfluencesDTOSchema, envelopeData(await get('/agen/influences')));
    expect(out.drift.length).toBeGreaterThan(0);
    expect(out.activity.length).toBeGreaterThan(0);
    expect(out.partners.length).toBeGreaterThan(0);
    expectContract(InfluencePartnerDTOSchema, out.partners[0]);
  });
});

describe('Era 2 read bodies (?era=2)', () => {
  it('GET /agents?era=2 → archived accounts: archivedAt set, a human, arm null', async () => {
    const items = listOf(await get('?era=2'), 'items');
    const parsed = items.map((i) => expectContract(AgentSummaryDTOSchema, i));
    expect(parsed.map((p) => p.username).sort()).toEqual(['liushang', 'simhum']);
    expect(parsed.every((p) => typeof p.archivedAt === 'string' && p.arm === null)).toBe(true);
    // The lab roster is the public analysis surface: unlike the platform DTOs
    // (publicAgentBackend), it carries a sealed human's agentBackend as stored.
    expect(parsed.find((p) => p.username === 'simhum')).toMatchObject({
      isAgent: false,
      cohort: 'human',
      agentBackend: 'claude:claude-haiku-5-5',
    });
  });

  it('GET /agents/alerts?era=2 → AlertsDTO with the Era 2 dream_rejected wording', async () => {
    const out = expectContract(AlertsDTOSchema, envelopeData(await get('/alerts?era=2')));
    for (const a of out.alerts) expectContract(AnomalyAlertDTOSchema, a);
    expect(out.alerts.map((a) => [a.username, a.kind])).toEqual([['liushang', 'dream_rejected']]);
  });
});

describe('persona and runtime read bodies', () => {
  it('GET /agents/:u/drift → { snapshots: DriftPointDTO[] } (with and without aspects)', async () => {
    const snapshots = listOf(await get('/agen/drift'), 'snapshots');
    expect(snapshots).toHaveLength(2);
    const parsed = snapshots.map((s) => expectContract(DriftPointDTOSchema, s));
    expect(parsed[0].aspects).toBeUndefined();
    expect(parsed[1]).toMatchObject({
      diffNarrative: 'moved on',
      aspects: { breached: ['style'] },
    });
  });

  it('GET /agents/:u/fidelity → FidelityDTO', async () => {
    const out = expectContract(FidelityDTOSchema, envelopeData(await get('/agen/fidelity')));
    expect(out.points.length).toBeGreaterThan(0);
    expectContract(FidelityPointDTOSchema, out.points[0]);
  });

  it('GET /agents/:u/events → { items: AgentEventDTO[] }', async () => {
    const items = listOf(await get('/agen/events'), 'items');
    expect(items.length).toBeGreaterThanOrEqual(4);
    const parsed = items.map((i) => expectContract(AgentEventDTOSchema, i));
    // A row without action/reason/targetId omits the keys rather than sending null.
    expect(parsed.some((e) => !('action' in e) && !('reason' in e))).toBe(true);
  });

  it('GET /agents/runtime → RuntimeHealthDTO', async () => {
    const out = expectContract(
      RuntimeHealthDTOSchema,
      envelopeData(await get('/runtime?range=7d')),
    );
    expect(out.points).toHaveLength(7);
    for (const p of out.points) expectContract(RuntimeHealthPointDTOSchema, p);
    expect(out).toMatchObject({ rounds: 1, missingSamples: 1, missingPostVectors: 1 });
  });
});

describe('Persona Bench read bodies', () => {
  it('GET /agents/benchmark/leaderboard → BenchmarkLeaderboardDTO', async () => {
    const out = expectContract(
      BenchmarkLeaderboardDTOSchema,
      envelopeData(await get('/benchmark/leaderboard')),
    );
    expect(out.rows).toHaveLength(2);
    for (const r of out.rows) expectContract(BenchmarkLeaderboardRowDTOSchema, r);
    expect(out.personas.length).toBeGreaterThan(0);
    expect(out.tasks.length).toBeGreaterThan(0);
  });

  it('GET /agents/benchmark/matrix → BenchmarkMatrixDTO', async () => {
    const out = expectContract(
      BenchmarkMatrixDTOSchema,
      envelopeData(await get('/benchmark/matrix')),
    );
    expect(out.cells.length).toBeGreaterThan(0);
    for (const c of out.cells) expectContract(BenchmarkMatrixCellDTOSchema, c);
  });

  it('GET /agents/benchmark/compare → BenchmarkCompareDTO', async () => {
    const out = expectContract(
      BenchmarkCompareDTOSchema,
      envelopeData(await get('/benchmark/compare?persona=agen&task=free_post')),
    );
    expect(out.items).toHaveLength(2);
    for (const i of out.items) expectContract(BenchmarkCompareItemDTOSchema, i);
  });
});

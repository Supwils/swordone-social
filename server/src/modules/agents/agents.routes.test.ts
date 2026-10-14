import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHash, randomBytes } from 'crypto';
import { agentsRouter } from './agents.routes';
import { createApp } from '../../app';
import { db } from '../../db/client';
import { resetDb } from '../../test/db-reset';
import { agentEvents, apiKeys, users } from '../../db/schema';
import { clearRuntimeHealthCache } from './agents.runtime';

/**
 * The lab router is the one place in the API where reads are deliberately
 * public and writes are not. That asymmetry used to be enforced by a single
 * `agentsRouter.use(requireUser)`; it is now per-route, which is safer for
 * reads but means a new POST added without `requireUser` would silently be
 * world-writable — and these endpoints ingest the personality snapshots the
 * whole drift experiment is measured from.
 *
 * So the invariant is asserted structurally, over the actual Express stack,
 * rather than trusted to review.
 */

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ name: string }>;
  };
}

function routes(): Array<{ path: string; method: string; handlers: string[] }> {
  const stack = (agentsRouter as unknown as { stack: RouteLayer[] }).stack;
  return stack
    .filter((layer): layer is Required<RouteLayer> => Boolean(layer.route))
    .flatMap((layer) =>
      Object.keys(layer.route.methods).map((method) => ({
        path: layer.route.path,
        method,
        handlers: layer.route.stack.map((h) => h.name),
      })),
    );
}

describe('agentsRouter auth boundary', () => {
  it('registers the expected number of routes', () => {
    // Guards against this suite silently passing because introspection broke.
    expect(routes().length).toBeGreaterThanOrEqual(18);
  });

  it('requires auth on every write route', () => {
    const unguarded = routes()
      .filter((r) => r.method !== 'get')
      .filter((r) => !r.handlers.includes('requireUser'))
      .map((r) => `${r.method.toUpperCase()} ${r.path}`);

    expect(unguarded).toEqual([]);
  });

  it('leaves every read route public', () => {
    const gated = routes()
      .filter((r) => r.method === 'get')
      .filter((r) => r.handlers.includes('requireUser'))
      .map((r) => `GET ${r.path}`);

    expect(gated).toEqual([]);
  });

  it('covers both a read and a write, so the two assertions above are not vacuous', () => {
    const methods = new Set(routes().map((r) => r.method));
    expect(methods.has('get')).toBe(true);
    expect(methods.has('post')).toBe(true);
  });
});

/**
 * `occurredAt` over the real HTTP stack.
 *
 * The service-level tests in `agents.service.test.ts` hand `ingestAgentEvent` a
 * `Date` directly, which cannot answer the two questions that decide whether a
 * backfill lands where it belongs:
 *
 * 1. Does `validate(agentEventIngest, 'body')` write its PARSED result back to
 *    `req.body`? If it only validated, the service would receive the raw ISO
 *    string rather than a `Date`.
 * 2. What does a server WITHOUT this field do with it? zod's `.object()` strips
 *    unknown keys, so the answer is "silently drops it and stamps now()" — no
 *    400, no warning. That is why a backfill must not be run against a
 *    deployment that predates this change, and it is asserted here rather than
 *    argued: `capturedAt` (the plausible wrong spelling, and the name the other
 *    three ingest DTOs use) stands in for any unknown key.
 */
describe('POST /agents/:username/events — occurredAt over HTTP', () => {
  // 01:35:04 PDT is 08:35:04 UTC — an offset silently dropped is a different
  // number, and either is weeks away from `now()`.
  const OCCURRED_AT = '2026-08-05T01:35:04-07:00';
  const OCCURRED_AT_UTC = '2026-08-05T08:35:04.000Z';

  const body = (over: Record<string, unknown> = {}) => ({
    type: 'anomaly',
    phase: 'anomaly',
    outcome: 'flagged',
    summary: 'personality.md hand-rolled back',
    metrics: { intervention: 'personality_rollback', gateBypassed: true },
    ...over,
  });

  async function agentWithKey(username: string): Promise<string> {
    const [user] = await db
      .insert(users)
      .values({
        username,
        usernameDisplay: username,
        email: `${username}@example.test`,
        displayName: username,
        isAgent: true,
      })
      .returning();
    const raw = `sk-swil-${randomBytes(8).toString('hex')}`;
    await db.insert(apiKeys).values({
      userId: user.id,
      name: 'test',
      keyHash: createHash('sha256').update(raw).digest('hex'),
    });
    return raw;
  }

  beforeEach(resetDb);

  it('stamps created_at with the instant the event is about', async () => {
    const key = await agentWithKey('zenith');

    const res = await request(createApp())
      .post('/api/v1/agents/zenith/events')
      .set('Authorization', `Bearer ${key}`)
      .send(body({ occurredAt: OCCURRED_AT }));

    expect(res.status).toBe(201);
    expect(res.body.data.event.createdAt).toBe(OCCURRED_AT_UTC);
    expect(res.body.data.event.metrics).toEqual({
      intervention: 'personality_rollback',
      gateBypassed: true,
    });
  });

  it('stamps now() when the field is absent — the live-runtime path', async () => {
    const key = await agentWithKey('zenith');
    const before = Date.now() - 1000;

    const res = await request(createApp())
      .post('/api/v1/agents/zenith/events')
      .set('Authorization', `Bearer ${key}`)
      .send(body());

    expect(res.status).toBe(201);
    expect(Date.parse(res.body.data.event.createdAt)).toBeGreaterThanOrEqual(before);
  });

  it('SILENTLY drops an unknown timestamp key rather than rejecting it', async () => {
    // The failure mode a backfill against an older deployment would hit: 201,
    // a well-formed event, and the wrong week.
    const key = await agentWithKey('zenith');
    const before = Date.now() - 1000;

    const res = await request(createApp())
      .post('/api/v1/agents/zenith/events')
      .set('Authorization', `Bearer ${key}`)
      .send(body({ capturedAt: OCCURRED_AT }));

    expect(res.status).toBe(201);
    expect(Date.parse(res.body.data.event.createdAt)).toBeGreaterThanOrEqual(before);
  });

  it('rejects a malformed occurredAt with a 400 rather than a bad row', async () => {
    const key = await agentWithKey('zenith');

    const res = await request(createApp())
      .post('/api/v1/agents/zenith/events')
      .set('Authorization', `Bearer ${key}`)
      .send(body({ occurredAt: 'yesterday' }));

    expect(res.status).toBe(400);
  });

  it('refuses a nested metrics value — the defect that ran six weeks unseen', async () => {
    const key = await agentWithKey('zenith');

    const res = await request(createApp())
      .post('/api/v1/agents/zenith/events')
      .set('Authorization', `Bearer ${key}`)
      .send(body({ metrics: { aspects: { values: 0.6 } } }));

    expect(res.status).toBe(400);
  });
});

/**
 * `GET /agents/runtime` — spec §5. Public lab read over `cycle_run` cards.
 * Discriminator is `metrics.kind = "cycle_run"`; per-action cycle events and
 * missingSampler audit rows (same `type='cycle'`, no kind) must not count.
 */
describe('GET /agents/runtime — cycle_run aggregate (spec §5)', () => {
  async function seedLabUser(username: string) {
    const [user] = await db
      .insert(users)
      .values({
        username,
        usernameDisplay: username,
        email: `${username}@example.test`,
        displayName: username,
        isAgent: true,
      })
      .returning();
    return user;
  }

  async function seedCycle(
    userId: string,
    metrics: Record<string, unknown>,
    over: { createdAt?: Date; summary?: string } = {},
  ) {
    await db.insert(agentEvents).values({
      userId,
      type: 'cycle',
      phase: 'act',
      outcome: 'warn',
      summary: over.summary ?? 'cycle_run fixture',
      metrics,
      ...(over.createdAt ? { createdAt: over.createdAt } : {}),
    });
  }

  beforeEach(async () => {
    await resetDb();
    clearRuntimeHealthCache();
  });

  it('registers GET /runtime as a literal path before /:username', () => {
    const listed = routes();
    const runtimeIdx = listed.findIndex((r) => r.method === 'get' && r.path === '/runtime');
    const usernameIdx = listed.findIndex((r) => r.path.startsWith('/:username'));
    expect(runtimeIdx).toBeGreaterThanOrEqual(0);
    expect(usernameIdx).toBeGreaterThan(runtimeIdx);
  });

  it('returns zeros and a zero-filled series when no cycle_run cards exist', async () => {
    const res = await request(createApp()).get('/api/v1/agents/runtime?range=7d');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      range: '7d',
      rounds: 0,
      accountsRun: 0,
      failOpenGates: 0,
      missingSamples: 0,
      landedActions: 0,
    });
    expect(res.body.data.points).toHaveLength(7);
    expect(
      res.body.data.points.every(
        (p: { rounds: number; failOpen: number; missingSamples: number; landed: number }) =>
          p.rounds === 0 && p.failOpen === 0 && p.missingSamples === 0 && p.landed === 0,
      ),
    ).toBe(true);
  });

  it('defaults range to 30d', async () => {
    const res = await request(createApp()).get('/api/v1/agents/runtime');
    expect(res.status).toBe(200);
    expect(res.body.data.range).toBe('30d');
    expect(res.body.data.points).toHaveLength(30);
  });

  it('counts a cycle_run card with a missing sampler toward missingSamples', async () => {
    const agent = await seedLabUser('zenith');
    await seedCycle(agent.id, {
      kind: 'cycle_run',
      attempted: 1,
      landed: 1,
      actOutcome: 'POSTED',
      grantsDream: true,
      dreamAccepted: null,
      gateStatus: 'skipped',
      missingBehaviorSnapshot: true,
      missingRuleCheck: false,
      durationMs: 10,
      backend: 'claude',
      model: 'haiku',
    });

    const res = await request(createApp()).get('/api/v1/agents/runtime?range=30d');

    expect(res.status).toBe(200);
    expect(res.body.data.rounds).toBe(1);
    expect(res.body.data.accountsRun).toBe(1);
    expect(res.body.data.missingSamples).toBe(1);
    expect(res.body.data.failOpenGates).toBe(0);
    expect(res.body.data.landedActions).toBe(1);
    const today = res.body.data.points.find(
      (p: { date: string }) => p.date === new Date().toISOString().slice(0, 10),
    );
    expect(today).toMatchObject({ rounds: 1, missingSamples: 1, failOpen: 0, landed: 1 });
  });

  it('ignores cycle events that are not kind=cycle_run', async () => {
    const agent = await seedLabUser('zenith');
    // Per-action cycle event (the live act path).
    await seedCycle(agent.id, {}, { summary: '→@someone' });
    // missingSampler audit row from a raising sampler — same type, no kind.
    await seedCycle(
      agent.id,
      { missingSampler: 'behavior_snapshot' },
      { summary: 'missing sampler behavior_snapshot' },
    );

    const res = await request(createApp()).get('/api/v1/agents/runtime?range=90d');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      range: '90d',
      rounds: 0,
      accountsRun: 0,
      failOpenGates: 0,
      missingSamples: 0,
      landedActions: 0,
    });
  });

  it('counts an Era 3 card that carries no gateStatus or missingRuleCheck', async () => {
    const agent = await seedLabUser('zenith');
    await seedCycle(agent.id, {
      kind: 'cycle_run',
      attempted: 1,
      landed: 1,
      actOutcome: 'landed_all',
      grantsDream: true,
      dreamAccepted: true,
      missingBehaviorSnapshot: false,
      durationMs: 10,
      backend: 'claude',
      model: 'claude-opus-5-5',
    });

    const res = await request(createApp()).get('/api/v1/agents/runtime?range=7d');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      rounds: 1,
      accountsRun: 1,
      failOpenGates: 0,
      missingSamples: 0,
      landedActions: 1,
    });
  });

  it('rolls fail-open gates, dual missing flags, and landed across accounts', async () => {
    const a = await seedLabUser('zenith');
    const b = await seedLabUser('liushang');
    await seedCycle(a.id, {
      kind: 'cycle_run',
      landed: 2,
      gateStatus: 'fail_open',
      missingBehaviorSnapshot: true,
      missingRuleCheck: true,
    });
    await seedCycle(b.id, {
      kind: 'cycle_run',
      landed: 3,
      gateStatus: 'accepted',
      missingBehaviorSnapshot: false,
      missingRuleCheck: false,
    });

    const res = await request(createApp()).get('/api/v1/agents/runtime?range=30d');

    expect(res.status).toBe(200);
    expect(res.body.data.rounds).toBe(2);
    expect(res.body.data.accountsRun).toBe(2);
    expect(res.body.data.failOpenGates).toBe(1);
    // One card, both flags true → still one missing sample, not two.
    expect(res.body.data.missingSamples).toBe(1);
    expect(res.body.data.landedActions).toBe(5);
  });
});

describe('lab write ingest — first-party agents only', () => {
  beforeEach(resetDb);

  async function keyFor(over: Partial<typeof users.$inferInsert> = {}) {
    const username = over.username ?? `labw${Math.random().toString(16).slice(2, 8)}`;
    const [user] = await db
      .insert(users)
      .values({
        username,
        usernameDisplay: username,
        email: `${username}@example.test`,
        displayName: username,
        ...over,
      })
      .returning();
    const raw = `sk-swil-${randomBytes(8).toString('hex')}`;
    await db.insert(apiKeys).values({
      userId: user.id,
      name: 'test',
      keyHash: createHash('sha256').update(raw).digest('hex'),
    });
    return { key: raw, user };
  }

  const benchBody = {
    batchId: 'b1',
    persona: 'zenith',
    model: 'haiku',
    taskId: 'free_post',
  };

  it('rejects a human writing a benchmark run', async () => {
    const { key } = await keyFor({ isAgent: false });
    const res = await request(createApp())
      .post('/api/v1/agents/benchmark/runs')
      .set('Authorization', `Bearer ${key}`)
      .send(benchBody);
    expect(res.status).toBe(403);
  });

  it('rejects a BYOA agent writing a benchmark run', async () => {
    const { user: owner } = await keyFor({ username: 'ownerhuman', isAgent: false });
    const { key } = await keyFor({
      username: 'communitybot',
      isAgent: true,
      ownerId: owner.id,
    });
    const res = await request(createApp())
      .post('/api/v1/agents/benchmark/runs')
      .set('Authorization', `Bearer ${key}`)
      .send(benchBody);
    expect(res.status).toBe(403);
  });

  it('accepts a first-party agent writing a benchmark run', async () => {
    const { key } = await keyFor({ username: 'zenith', isAgent: true });
    const res = await request(createApp())
      .post('/api/v1/agents/benchmark/runs')
      .set('Authorization', `Bearer ${key}`)
      .send(benchBody);
    expect(res.status).toBe(201);
  });

  it('lets an archived first-party agent write benchmark runs only', async () => {
    const { key } = await keyFor({ username: 'sealed', isAgent: true, archivedAt: new Date() });
    const bench = await request(createApp())
      .post('/api/v1/agents/benchmark/runs')
      .set('Authorization', `Bearer ${key}`)
      .send(benchBody);
    expect(bench.status).toBe(201);

    const post = await request(createApp())
      .post('/api/v1/posts')
      .set('Authorization', `Bearer ${key}`)
      .send({ text: 'still talking' });
    expect(post.status).toBe(403);
    expect(post.body.error.message).toBe('This account is archived (Era 2)');

    const read = await request(createApp())
      .get('/api/v1/agents/runtime?range=30d')
      .set('Authorization', `Bearer ${key}`);
    expect(read.status).toBe(200);
  });

  it('rejects a human writing a population metric', async () => {
    const { key } = await keyFor({ isAgent: false });
    const res = await request(createApp())
      .post('/api/v1/agents/population-metric')
      .set('Authorization', `Bearer ${key}`)
      .send({});
    expect(res.status).toBe(403);
  });
});

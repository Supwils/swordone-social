import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHash, randomBytes } from 'crypto';
import { agentsRouter } from './agents.routes';
import { createApp } from '../../app';
import { db } from '../../db/client';
import { resetDb } from '../../test/db-reset';
import { agentEvents, apiKeys, likes, posts, users } from '../../db/schema';
import { clearRuntimeHealthCache } from './runtime/runtime';
import { clearAlertsCache } from './population/pulse';

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

interface StackLayer {
  name: string;
  handle: { stack?: StackLayer[] };
  regexp: RegExp & { fast_slash?: boolean };
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ name: string }>;
  };
}

const rootStack = (agentsRouter as unknown as { stack: StackLayer[] }).stack;

/** The sub-routers `agents.routes.ts` mounts (any non-route layer with its own stack). */
function subRouters(): StackLayer[] {
  return rootStack.filter((layer) => !layer.route && Array.isArray(layer.handle.stack));
}

/**
 * Every route in registration order, recursing into nested routers. Sub-routers
 * are mounted at the root (asserted below), so a route's own path is its full
 * path under `/api/v1/agents`.
 */
function routes(
  stack: StackLayer[] = rootStack,
): Array<{ path: string; method: string; handlers: string[] }> {
  return stack.flatMap((layer) => {
    if (layer.route) {
      const route = layer.route;
      return Object.keys(route.methods).map((method) => ({
        path: route.path,
        method,
        handlers: route.stack.map((h) => h.name),
      }));
    }
    return layer.handle.stack ? routes(layer.handle.stack) : [];
  });
}

/** True when an earlier route `a` would capture every request meant for `b`. */
function shadows(a: string, b: string): boolean {
  const as = a.split('/');
  const bs = b.split('/');
  return as.length === bs.length && as.every((seg, i) => seg === bs[i] || seg.startsWith(':'));
}

describe('agentsRouter auth boundary', () => {
  it('registers the expected number of routes', () => {
    // Guards against this suite silently passing because introspection broke.
    expect(routes().length).toBeGreaterThanOrEqual(18);
  });

  it('requires auth on every write route; the observer note is the one token-gated write', () => {
    const unguarded = routes()
      .filter((r) => r.method !== 'get')
      .filter((r) => !r.handlers.includes('requireUser'))
      .map((r) => `${r.method.toUpperCase()} ${r.path}`);

    // Written by the operator's round, never by a session: its one guard is
    // the observer token (lab v2 §5), asserted below.
    expect(unguarded).toEqual(['PUT /rounds/:roundId/observation']);
  });

  it('guards the observer note with the observer token before anything else', () => {
    const put = routes().find(
      (r) => r.method === 'put' && r.path === '/rounds/:roundId/observation',
    );
    expect(put?.handlers[0]).toBe('requireObserverToken');
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

  it('recurses into the mounted sub-routers', () => {
    // Guards the recursion itself: the root holds no routes of its own.
    expect(subRouters().length).toBeGreaterThanOrEqual(5);
    expect(rootStack.filter((layer) => layer.route)).toEqual([]);
  });

  it('mounts every sub-router at the root, so a route path is its full path', () => {
    const mountedElsewhere = subRouters().filter((layer) => !layer.regexp.fast_slash);
    expect(mountedElsewhere).toEqual([]);
  });

  it('gives sub-routers no router-level middleware (per-route only)', () => {
    const routerLevel = subRouters().flatMap((sub) =>
      (sub.handle.stack ?? []).filter((layer) => !layer.route).map((layer) => layer.name),
    );
    expect(routerLevel).toEqual([]);
  });

  it('registers each (method, full path) pair exactly once', () => {
    const seen = new Map<string, number>();
    for (const r of routes()) {
      const key = `${r.method.toUpperCase()} ${r.path}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const duplicated = [...seen].filter(([, n]) => n > 1).map(([key]) => key);
    expect(duplicated).toEqual([]);
  });

  it('never registers a route after an earlier one of the same method that captures it', () => {
    const listed = routes();
    const shadowed = listed.flatMap((r, i) =>
      listed
        .slice(0, i)
        .filter((earlier) => earlier.method === r.method && shadows(earlier.path, r.path))
        .map((earlier) => `${r.method.toUpperCase()} ${r.path} <- ${earlier.path}`),
    );
    expect(shadowed).toEqual([]);
  });
});

/**
 * `occurredAt` over the real HTTP stack.
 *
 * The service-level tests in `runtime/events.test.ts` hand `ingestAgentEvent` a
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

  it('refuses occurredAt on any type but anomaly — a cycle_run card cannot be backdated', async () => {
    const key = await agentWithKey('zenith');

    const res = await request(createApp())
      .post('/api/v1/agents/zenith/events')
      .set('Authorization', `Bearer ${key}`)
      .send(
        body({
          type: 'cycle',
          phase: 'act',
          outcome: 'success',
          metrics: { kind: 'cycle_run' },
          occurredAt: OCCURRED_AT,
        }),
      );

    expect(res.status).toBe(400);
    expect(res.body.error.fields).toHaveProperty('occurredAt');
    expect(await db.select().from(agentEvents)).toHaveLength(0);
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

  it('registers GET /rounds and /rounds/:roundId publicly, after /runtime and before the /:username reads', () => {
    const listed = routes();
    const getIdx = (path: string) => listed.findIndex((r) => r.method === 'get' && r.path === path);
    const runtimeIdx = getIdx('/runtime');
    // persona's and arms' per-account reads, mounted after the rounds router
    const laterReads = ['/:username/drift', '/:username/rounds'].map(getIdx);
    for (const path of ['/rounds', '/rounds/:roundId']) {
      const idx = getIdx(path);
      expect(idx).toBeGreaterThan(runtimeIdx);
      expect(listed[idx].handlers).not.toContain('requireUser');
      for (const later of laterReads) expect(later).toBeGreaterThan(idx);
      const shadowedBy = listed
        .slice(0, idx)
        .filter((r) => r.method === 'get' && shadows(r.path, path))
        .map((r) => r.path);
      expect(shadowedBy).toEqual([]);
    }
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

describe('era scoping over HTTP (S2 §6)', () => {
  async function seedUser(username: string, over: Partial<typeof users.$inferInsert> = {}) {
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
    return user;
  }

  async function seedCard(userId: string, metrics: Record<string, unknown>) {
    await db.insert(agentEvents).values({
      userId,
      type: 'cycle',
      phase: 'act',
      outcome: 'success',
      summary: 'cycle_run fixture',
      metrics: { kind: 'cycle_run', ...metrics },
    });
  }

  beforeEach(async () => {
    await resetDb();
    clearRuntimeHealthCache();
    clearAlertsCache();
  });

  it('per-account reads take no era: /:u/stats?era=x is not rejected for it', async () => {
    await seedUser('agen', { isAgent: true });

    const res = await request(createApp()).get('/api/v1/agents/agen/stats?range=7d&era=x');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ username: 'agen', range: '7d' });
  });

  it('runtime skips a suspended Era 3 agent’s cards', async () => {
    const live = await seedUser('agen', { isAgent: true });
    const suspended = await seedUser('awen', { isAgent: true, status: 'suspended' });
    await seedCard(live.id, { landed: 1 });
    await seedCard(suspended.id, { landed: 4, missingPostVector: true });

    const res = await request(createApp()).get('/api/v1/agents/runtime?range=30d');

    expect(res.body.data).toMatchObject({
      rounds: 1,
      accountsRun: 1,
      landedActions: 1,
      missingPostVectors: 0,
    });
  });

  it.each([
    '/api/v1/agents?era=x',
    '/api/v1/agents/overview?era=x',
    '/api/v1/agents/graph?era=4',
    '/api/v1/agents/homogenization?era=1',
    '/api/v1/agents/pulse?era=three',
    '/api/v1/agents/runtime?era=',
    '/api/v1/agents/alerts?era=x',
  ])('rejects a bad era value: %s', async (path) => {
    const res = await request(createApp()).get(path);
    expect(res.status).toBe(400);
  });

  it('GET /agents defaults to Era 3 and era=2 returns archived accounts only', async () => {
    const owner = await seedUser('owner1');
    await seedUser('agen', { isAgent: true });
    await seedUser('byoabot', { isAgent: true, ownerId: owner.id });
    await seedUser('simhum', { isAgent: false, archivedAt: null, agentBackend: 'haiku' });
    await seedUser('liushang', { isAgent: true, archivedAt: new Date() });

    const def = await request(createApp()).get('/api/v1/agents');
    const era2 = await request(createApp()).get('/api/v1/agents?era=2');

    expect(def.status).toBe(200);
    expect(def.body.data.items.map((i: { username: string }) => i.username)).toEqual(['agen']);
    expect(def.body.data.items[0]).toMatchObject({ arm: 'claude-opus', archivedAt: null });
    expect(era2.body.data.items.map((i: { username: string }) => i.username)).toEqual(['liushang']);
  });

  it('runtime counts only the era’s cards and sums missingPostVector', async () => {
    const live = await seedUser('agen', { isAgent: true });
    const live2 = await seedUser('awen', { isAgent: true });
    const sealed = await seedUser('liushang', { isAgent: true, archivedAt: new Date() });
    const owner = await seedUser('owner1');
    const byoa = await seedUser('byoabot', { isAgent: true, ownerId: owner.id });
    await seedCard(live.id, { landed: 1, missingPostVector: true, roundId: '20261014T010203Z-r' });
    await seedCard(live2.id, { landed: 2, missingPostVector: false });
    // A string 'true' is not a boolean flag: it must not count.
    await seedCard(live2.id, { landed: 0, missingPostVector: 'true' });
    await seedCard(sealed.id, { landed: 5, gateStatus: 'fail_open' });
    await seedCard(byoa.id, { landed: 7, missingPostVector: true });

    const era3 = await request(createApp()).get('/api/v1/agents/runtime?range=7d');
    // Same range, other era: a cache keyed on range alone would replay era3.
    const era2 = await request(createApp()).get('/api/v1/agents/runtime?range=7d&era=2');

    expect(era3.status).toBe(200);
    expect(era3.body.data).toMatchObject({
      rounds: 3,
      accountsRun: 2,
      landedActions: 3,
      failOpenGates: 0,
      missingPostVectors: 1,
    });
    const today = new Date().toISOString().slice(0, 10);
    const point = era3.body.data.points.find((p: { date: string }) => p.date === today);
    expect(point).toMatchObject({ rounds: 3, missingPostVectors: 1 });
    expect(
      era3.body.data.points
        .filter((p: { date: string }) => p.date !== today)
        .every((p: { missingPostVectors: number }) => p.missingPostVectors === 0),
    ).toBe(true);

    expect(era2.body.data).toMatchObject({
      rounds: 1,
      accountsRun: 1,
      landedActions: 5,
      failOpenGates: 1,
      missingPostVectors: 0,
    });
  });

  it('alerts for the same range differ by era', async () => {
    const live = await seedUser('agen', { isAgent: true });
    const sealed = await seedUser('liushang', { isAgent: true, archivedAt: new Date() });
    for (const userId of [live.id, live.id, sealed.id, sealed.id]) {
      await db.insert(agentEvents).values({
        userId,
        type: 'dream',
        phase: 'dream',
        outcome: 'fail',
        summary: 'dream fail',
        metrics: {},
      });
    }

    const era3 = await request(createApp()).get('/api/v1/agents/alerts?range=7d');
    const era2 = await request(createApp()).get('/api/v1/agents/alerts?range=7d&era=2');

    expect(era3.body.data.alerts).toEqual([
      expect.objectContaining({ username: 'agen', kind: 'dream_failed' }),
    ]);
    expect(era2.body.data.alerts).toEqual([
      expect.objectContaining({ username: 'liushang', kind: 'dream_rejected' }),
    ]);
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

/**
 * SA-F1 over HTTP: the per-account reads are public, so they answer only for an
 * account that is openly in the experiment — an agent, or a sealed (archived)
 * Era 2 participant. They used to serve any active human's cadence, likers and
 * private-post lengths to anyone who knew the username.
 */
describe('per-account lab reads answer only for lab accounts', () => {
  const READS = [
    'stats',
    'collapse',
    'influences',
    'rounds',
    'drift',
    'drift-countdown',
    'fidelity',
    'events',
  ];

  async function seedAccount(username: string, over: Partial<typeof users.$inferInsert> = {}) {
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
    return user;
  }

  beforeEach(resetDb);

  it('404s an ordinary human — with a private post and a like to leak — on every read', async () => {
    const human = await seedAccount('ordinaryhuman', { isAgent: false });
    const peer = await seedAccount('somepeer', { isAgent: true });
    const [secret] = await db
      .insert(posts)
      .values({ authorId: human.id, text: 'private thoughts', visibility: 'private' })
      .returning();
    await db.insert(likes).values({ userId: peer.id, targetType: 'post', targetId: secret.id });
    const app = createApp();

    const statuses = await Promise.all(
      READS.map(async (r) => [
        r,
        (await request(app).get(`/api/v1/agents/ordinaryhuman/${r}`)).status,
      ]),
    );
    expect(statuses).toEqual(READS.map((r) => [r, 404]));
  });

  it('serves an agent and a sealed Era 2 simulated human', async () => {
    await seedAccount('labagent', { isAgent: true });
    await seedAccount('sealedhuman', { isAgent: false, archivedAt: new Date() });
    const app = createApp();

    for (const name of ['labagent', 'sealedhuman']) {
      const statuses = await Promise.all(
        READS.map(async (r) => [r, (await request(app).get(`/api/v1/agents/${name}/${r}`)).status]),
      );
      expect(statuses).toEqual(READS.map((r) => [r, 200]));
    }
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { newId } from '../../lib/id';

const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
  getAgentStats: vi.fn(),
  getDrift: vi.fn(),
  getDriftCountdown: vi.fn(),
  getCollapseWatch: vi.fn(),
  collapseWindow: vi.fn(),
  getOverview: vi.fn(),
  getInteractionGraph: vi.fn(),
  getHomogenization: vi.fn(),
  recordPopulationMetric: vi.fn(),
  getPulse: vi.fn(),
  getRuntimeHealth: vi.fn(),
  getAlerts: vi.fn(),
  getInfluences: vi.fn(),
  getAgentEvents: vi.fn(),
  ingestAgentEvent: vi.fn(),
  ingestSnapshot: vi.fn(),
  getFidelity: vi.fn(),
  ingestBehaviorSnapshot: vi.fn(),
  ingestBenchmarkRun: vi.fn(),
  getBenchmarkLeaderboard: vi.fn(),
  getBenchmarkMatrix: vi.fn(),
  getBenchmarkCompare: vi.fn(),
}));

// Every symbol the controller reads must exist here — a missing one becomes
// `undefined` at call time and fails far from the cause (19-testing-standards §4).
vi.mock('./agents.service', () => mocks);

import { AppError } from '../../lib/errors';
import type { UserRow } from '../../lib/dto';
import * as ctrl from './agents.controller';

function makeRes() {
  const res = {
    statusCode: 200,
    payload: undefined as unknown,
    req: { id: 'req-1' },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.payload = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; payload: unknown };
}

const firstPartyAgent = { id: newId(), isAgent: true, ownerId: null } as unknown as UserRow;
const human = { id: newId(), isAgent: false, ownerId: null } as unknown as UserRow;
const byoaAgent = { id: newId(), isAgent: true, ownerId: newId() } as unknown as UserRow;

function req(over: Record<string, unknown> = {}): Request {
  return { params: {}, query: {}, body: {}, ...over } as unknown as Request;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('agents.controller range-defaulting reads', () => {
  // Every one of these accepts ?range= and must default to 30d — and must
  // pass an explicit 7d through rather than swallowing it.
  const cases: Array<{
    name: string;
    handler: (rq: Request, rs: Response) => Promise<unknown>;
    svc: keyof typeof mocks;
    params?: Record<string, string>;
    args: (range: string) => unknown[];
  }> = [
    {
      name: 'stats',
      handler: ctrl.stats,
      svc: 'getAgentStats',
      params: { username: 'zed' },
      args: (r) => ['zed', r],
    },
    {
      name: 'driftCountdown',
      handler: ctrl.driftCountdown,
      svc: 'getDriftCountdown',
      params: { username: 'zed' },
      args: (r) => ['zed', r],
    },
    { name: 'graph', handler: ctrl.graph, svc: 'getInteractionGraph', args: (r) => [r] },
    {
      name: 'homogenization',
      handler: ctrl.homogenization,
      svc: 'getHomogenization',
      args: (r) => [r],
    },
    { name: 'pulse', handler: ctrl.pulse, svc: 'getPulse', args: (r) => [r] },
    { name: 'runtime', handler: ctrl.runtime, svc: 'getRuntimeHealth', args: (r) => [r] },
    { name: 'alerts', handler: ctrl.alerts, svc: 'getAlerts', args: (r) => [r] },
    {
      name: 'influences',
      handler: ctrl.influences,
      svc: 'getInfluences',
      params: { username: 'zed' },
      args: (r) => ['zed', r],
    },
  ];

  it.each(cases)('$name defaults to 30d and honours an explicit 7d', async (c) => {
    mocks[c.svc].mockResolvedValue({ ok: 1 });

    await c.handler(req({ params: c.params ?? {} }), makeRes());
    expect(mocks[c.svc]).toHaveBeenLastCalledWith(...c.args('30d'));

    await c.handler(req({ params: c.params ?? {}, query: { range: '7d' } }), makeRes());
    expect(mocks[c.svc]).toHaveBeenLastCalledWith(...c.args('7d'));
  });

  it('collapse resolves the range into an explicit window before the service', async () => {
    const window = { from: 'sentinel-from', to: 'sentinel-to' };
    mocks.collapseWindow.mockReturnValue(window);
    mocks.getCollapseWatch.mockResolvedValue({ ok: 1 });

    await ctrl.collapse(req({ params: { username: 'zed' }, query: { range: '90d' } }), makeRes());

    expect(mocks.collapseWindow).toHaveBeenCalledWith('90d', expect.any(Date));
    expect(mocks.getCollapseWatch).toHaveBeenCalledWith('zed', window);
  });
});

describe('agents.controller simple reads', () => {
  it('list defaults the limit to 50 and passes an explicit one through', async () => {
    mocks.listAgents.mockResolvedValue([{ username: 'zed' }]);

    const res = makeRes();
    await ctrl.list(req(), res);
    expect(mocks.listAgents).toHaveBeenLastCalledWith(50);
    expect(res.payload).toEqual({
      data: { items: [{ username: 'zed' }] },
      meta: { requestId: 'req-1' },
    });

    await ctrl.list(req({ query: { limit: 5 } }), makeRes());
    expect(mocks.listAgents).toHaveBeenLastCalledWith(5);
  });

  it('events defaults limit 20 and forwards the type filter', async () => {
    mocks.getAgentEvents.mockResolvedValue([]);

    await ctrl.events(req({ params: { username: 'zed' } }), makeRes());
    expect(mocks.getAgentEvents).toHaveBeenLastCalledWith('zed', 20, undefined);

    await ctrl.events(
      req({ params: { username: 'zed' }, query: { limit: 5, type: 'dream' } }),
      makeRes(),
    );
    expect(mocks.getAgentEvents).toHaveBeenLastCalledWith('zed', 5, 'dream');
  });

  it('drift and fidelity read by username', async () => {
    mocks.getDrift.mockResolvedValue([{ v: 1 }]);
    mocks.getFidelity.mockResolvedValue({ f: 1 });

    const res = makeRes();
    await ctrl.drift(req({ params: { username: 'zed' } }), res);
    expect(mocks.getDrift).toHaveBeenCalledWith('zed');
    expect(res.payload).toEqual({
      data: { snapshots: [{ v: 1 }] },
      meta: { requestId: 'req-1' },
    });

    await ctrl.fidelity(req({ params: { username: 'zed' } }), makeRes());
    expect(mocks.getFidelity).toHaveBeenCalledWith('zed');
  });

  it('benchmarkCompare forwards persona and task from the query', async () => {
    mocks.getBenchmarkCompare.mockResolvedValue({ rows: [] });

    await ctrl.benchmarkCompare(
      req({ query: { persona: 'liushang', task: 'free_post' } }),
      makeRes(),
    );

    expect(mocks.getBenchmarkCompare).toHaveBeenCalledWith('liushang', 'free_post');
  });
});

describe('agents.controller ingest guards', () => {
  it('per-account ingests demand a user and pass (username, actor, body) through', async () => {
    const body = { kind: 'dream' };
    mocks.ingestAgentEvent.mockResolvedValue({ id: 'e-1' });
    mocks.ingestSnapshot.mockResolvedValue({ id: 's-1' });
    mocks.ingestBehaviorSnapshot.mockResolvedValue({ id: 'b-1' });

    await expect(
      ctrl.ingestEvent(req({ params: { username: 'zed' }, body }), makeRes()),
    ).rejects.toThrow(AppError);

    const res = makeRes();
    await ctrl.ingestEvent(req({ user: firstPartyAgent, params: { username: 'zed' }, body }), res);
    expect(mocks.ingestAgentEvent).toHaveBeenCalledWith('zed', firstPartyAgent, body);
    expect(res.statusCode).toBe(201);

    await ctrl.ingest(req({ user: firstPartyAgent, params: { username: 'zed' }, body }), makeRes());
    expect(mocks.ingestSnapshot).toHaveBeenCalledWith('zed', firstPartyAgent, body);

    await ctrl.ingestBehavior(
      req({ user: firstPartyAgent, params: { username: 'zed' }, body }),
      makeRes(),
    );
    expect(mocks.ingestBehaviorSnapshot).toHaveBeenCalledWith('zed', firstPartyAgent, body);
  });

  it.each([
    ['recordPopulation', ctrl.recordPopulation, 'recordPopulationMetric' as const],
    ['benchmarkIngest', ctrl.benchmarkIngest, 'ingestBenchmarkRun' as const],
  ])('%s refuses humans and BYOA agents, allows first-party agents', async (_n, handler, svcKey) => {
    mocks[svcKey].mockResolvedValue({ ok: 1 });

    await expect(handler(req(), makeRes())).rejects.toThrow(AppError);
    await expect(handler(req({ user: human }), makeRes())).rejects.toThrow(
      'Lab writes are limited to first-party agent accounts',
    );
    await expect(handler(req({ user: byoaAgent }), makeRes())).rejects.toThrow(
      'Lab writes are limited to first-party agent accounts',
    );
    expect(mocks[svcKey]).not.toHaveBeenCalled();

    const res = makeRes();
    await handler(req({ user: firstPartyAgent }), res);
    expect(mocks[svcKey]).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(201);
  });
});

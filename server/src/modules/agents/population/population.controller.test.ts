import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
  getAgentStats: vi.fn(),
  getOverview: vi.fn(),
  getInteractionGraph: vi.fn(),
  getHomogenization: vi.fn(),
  recordPopulationMetric: vi.fn(),
  getPulse: vi.fn(),
  getAlerts: vi.fn(),
  getInfluences: vi.fn(),
}));

// Every symbol the controller reads must exist here — a missing one becomes
// `undefined` at call time and fails far from the cause (19-testing-standards §4).
vi.mock('./roster', () => mocks);
vi.mock('./population', () => mocks);
vi.mock('./graph', () => mocks);
vi.mock('./pulse', () => mocks);

import { AppError } from '../../../lib/errors';
import { byoaAgent, firstPartyAgent, human, makeRes, req } from '../lab/lab.testSeeds';
import * as ctrl from './population.controller';

afterEach(() => {
  vi.clearAllMocks();
});

describe('population.controller range-defaulting reads', () => {
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
    // Population reads also take the era; without a parsed one it is Era 3.
    { name: 'graph', handler: ctrl.graph, svc: 'getInteractionGraph', args: (r) => [r, 3] },
    {
      name: 'homogenization',
      handler: ctrl.homogenization,
      svc: 'getHomogenization',
      args: (r) => [r, 3],
    },
    { name: 'pulse', handler: ctrl.pulse, svc: 'getPulse', args: (r) => [r, 3] },
    { name: 'alerts', handler: ctrl.alerts, svc: 'getAlerts', args: (r) => [r, 3] },
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

  it.each([
    ['graph', ctrl.graph, 'getInteractionGraph' as const],
    ['homogenization', ctrl.homogenization, 'getHomogenization' as const],
    ['pulse', ctrl.pulse, 'getPulse' as const],
    ['alerts', ctrl.alerts, 'getAlerts' as const],
  ])('%s forwards a parsed era 2', async (_n, handler, svcKey) => {
    mocks[svcKey].mockResolvedValue({ ok: 1 });

    await handler(req({ query: { range: '90d', era: 2 } }), makeRes());

    expect(mocks[svcKey]).toHaveBeenLastCalledWith('90d', 2);
  });
});

describe('population.controller simple reads', () => {
  it('list defaults the limit to 50 and passes an explicit one through', async () => {
    mocks.listAgents.mockResolvedValue([{ username: 'zed' }]);

    const res = makeRes();
    await ctrl.list(req(), res);
    expect(mocks.listAgents).toHaveBeenLastCalledWith(50, 3);
    expect(res.payload).toEqual({
      data: { items: [{ username: 'zed' }] },
      meta: { requestId: 'req-1' },
    });

    await ctrl.list(req({ query: { limit: 5, era: 2 } }), makeRes());
    expect(mocks.listAgents).toHaveBeenLastCalledWith(5, 2);
  });

  it('overview defaults to Era 3 and forwards a parsed era', async () => {
    mocks.getOverview.mockResolvedValue({ cohorts: {} });

    await ctrl.overview(req(), makeRes());
    expect(mocks.getOverview).toHaveBeenLastCalledWith(3);

    await ctrl.overview(req({ query: { era: 2 } }), makeRes());
    expect(mocks.getOverview).toHaveBeenLastCalledWith(2);
  });
});

describe('population.controller ingest guards', () => {
  it.each([['recordPopulation', ctrl.recordPopulation, 'recordPopulationMetric' as const]])(
    '%s refuses humans and BYOA agents, allows first-party agents',
    async (_n, handler, svcKey) => {
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
    },
  );
});

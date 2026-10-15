import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ingestBenchmarkRun: vi.fn(),
  getBenchmarkLeaderboard: vi.fn(),
  getBenchmarkMatrix: vi.fn(),
  getBenchmarkCompare: vi.fn(),
}));

// Every symbol the controller reads must exist here — a missing one becomes
// `undefined` at call time and fails far from the cause (19-testing-standards §4).
vi.mock('./benchmark', () => mocks);

import { AppError } from '../../../lib/errors';
import { byoaAgent, firstPartyAgent, human, makeRes, req } from '../lab/lab.testSeeds';
import * as ctrl from './bench.controller';

afterEach(() => {
  vi.clearAllMocks();
});

describe('bench.controller simple reads', () => {
  it('benchmarkCompare forwards persona and task from the query', async () => {
    mocks.getBenchmarkCompare.mockResolvedValue({ rows: [] });

    await ctrl.benchmarkCompare(
      req({ query: { persona: 'liushang', task: 'free_post' } }),
      makeRes(),
    );

    expect(mocks.getBenchmarkCompare).toHaveBeenCalledWith('liushang', 'free_post');
  });
});

describe('bench.controller ingest guards', () => {
  it.each([['benchmarkIngest', ctrl.benchmarkIngest, 'ingestBenchmarkRun' as const]])(
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

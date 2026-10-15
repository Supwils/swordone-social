import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRuntimeHealth: vi.fn(),
  getAgentEvents: vi.fn(),
  ingestAgentEvent: vi.fn(),
}));

// Every symbol the controller reads must exist here — a missing one becomes
// `undefined` at call time and fails far from the cause (19-testing-standards §4).
vi.mock('./runtime', () => mocks);
vi.mock('./events', () => mocks);

import { AppError } from '../../../lib/errors';
import { firstPartyAgent, makeRes, req } from '../lab/lab.testSeeds';
import * as ctrl from './runtime.controller';

afterEach(() => {
  vi.clearAllMocks();
});

describe('runtime.controller range-defaulting reads', () => {
  it('runtime defaults to 30d and honours an explicit 7d', async () => {
    mocks.getRuntimeHealth.mockResolvedValue({ ok: 1 });

    // A population read: without a parsed era it is Era 3.
    await ctrl.runtime(req(), makeRes());
    expect(mocks.getRuntimeHealth).toHaveBeenLastCalledWith('30d', 3);

    await ctrl.runtime(req({ query: { range: '7d' } }), makeRes());
    expect(mocks.getRuntimeHealth).toHaveBeenLastCalledWith('7d', 3);
  });

  it('runtime forwards a parsed era 2', async () => {
    mocks.getRuntimeHealth.mockResolvedValue({ ok: 1 });

    await ctrl.runtime(req({ query: { range: '90d', era: 2 } }), makeRes());

    expect(mocks.getRuntimeHealth).toHaveBeenLastCalledWith('90d', 2);
  });
});

describe('runtime.controller simple reads', () => {
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
});

describe('runtime.controller ingest guards', () => {
  it('per-account ingests demand a user and pass (username, actor, body) through', async () => {
    const body = { kind: 'dream' };
    mocks.ingestAgentEvent.mockResolvedValue({ id: 'e-1' });

    await expect(
      ctrl.ingestEvent(req({ params: { username: 'zed' }, body }), makeRes()),
    ).rejects.toThrow(AppError);

    const res = makeRes();
    await ctrl.ingestEvent(req({ user: firstPartyAgent, params: { username: 'zed' }, body }), res);
    expect(mocks.ingestAgentEvent).toHaveBeenCalledWith('zed', firstPartyAgent, body);
    expect(res.statusCode).toBe(201);
  });
});

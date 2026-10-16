import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDrift: vi.fn(),
  getDriftCountdown: vi.fn(),
  getCollapseWatch: vi.fn(),
  ingestSnapshot: vi.fn(),
  getFidelity: vi.fn(),
  ingestBehaviorSnapshot: vi.fn(),
}));

// Every symbol the controller reads must exist here — a missing one becomes
// `undefined` at call time and fails far from the cause (19-testing-standards §4).
vi.mock('./drift', () => mocks);
vi.mock('./countdown', () => mocks);
vi.mock('./collapse', () => mocks);

import { firstPartyAgent, makeRes, req } from '../lab/lab.testSeeds';
import * as ctrl from './persona.controller';

afterEach(() => {
  vi.clearAllMocks();
});

describe('persona.controller range-defaulting reads', () => {
  it('driftCountdown defaults to 30d and honours an explicit 7d', async () => {
    mocks.getDriftCountdown.mockResolvedValue({ ok: 1 });

    await ctrl.driftCountdown(req({ params: { username: 'zed' } }), makeRes());
    expect(mocks.getDriftCountdown).toHaveBeenLastCalledWith('zed', '30d');

    await ctrl.driftCountdown(
      req({ params: { username: 'zed' }, query: { range: '7d' } }),
      makeRes(),
    );
    expect(mocks.getDriftCountdown).toHaveBeenLastCalledWith('zed', '7d');
  });

  it('collapse hands the requested range to the service, which owns the window', async () => {
    // The window's end depends on the account (its seal, or now), which only
    // the service knows after the lookup — so the controller passes the range.
    mocks.getCollapseWatch.mockResolvedValue({ ok: 1 });

    await ctrl.collapse(req({ params: { username: 'zed' }, query: { range: '90d' } }), makeRes());
    expect(mocks.getCollapseWatch).toHaveBeenLastCalledWith('zed', '90d');

    await ctrl.collapse(req({ params: { username: 'zed' } }), makeRes());
    expect(mocks.getCollapseWatch).toHaveBeenLastCalledWith('zed', '30d');
  });
});

describe('persona.controller simple reads', () => {
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
});

describe('persona.controller ingest guards', () => {
  it('per-account ingests pass (username, actor, body) through', async () => {
    const body = { kind: 'dream' };
    mocks.ingestSnapshot.mockResolvedValue({ id: 's-1' });
    mocks.ingestBehaviorSnapshot.mockResolvedValue({ id: 'b-1' });

    await ctrl.ingest(req({ user: firstPartyAgent, params: { username: 'zed' }, body }), makeRes());
    expect(mocks.ingestSnapshot).toHaveBeenCalledWith('zed', firstPartyAgent, body);

    await ctrl.ingestBehavior(
      req({ user: firstPartyAgent, params: { username: 'zed' }, body }),
      makeRes(),
    );
    expect(mocks.ingestBehaviorSnapshot).toHaveBeenCalledWith('zed', firstPartyAgent, body);
  });
});

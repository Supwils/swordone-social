/**
 * Tests for `AgentDetail`'s wiring of the two new panels and of the drift
 * thresholds.
 *
 * WHY THIS FILE EXISTS AT ALL. `AgentDetail.tsx:22` used to hold
 * `ASPECT_THRESHOLDS = { values: 0.63, style: 0.72, topic: 0.71 }` — a third
 * copy of the gate's thresholds, whose comment said to keep it in sync with the
 * Era 1 Bash dream script (deleted; Era 3 has no drift gate, 2026-10-14).
 * The thresholds now travel beside each measurement and are read off the wire.
 * Deleting the constant is only half the fix: without a test, a later hand could
 * put the numbers back and nothing would go red.
 *
 * FIXTURE RULE (standing constraint §4). The three thresholds here are
 * 0.55 / 0.66 / 0.61 — deliberately NOT the real 0.63 / 0.72 / 0.71, so a
 * restored constant is distinguishable from a value read off the wire. `range`
 * is `7d`, not the `30d` every other query in this component asks for.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import '@/i18n';

vi.mock('@/features/lab/api', () => ({
  getAgentDrift: vi.fn(),
  getAgentEvents: vi.fn(),
  getAgentFidelity: vi.fn(),
  getAgentStats: vi.fn(),
  getInfluences: vi.fn(),
  getDriftCountdown: vi.fn(),
  getCollapseWatch: vi.fn(),
}));

import * as agentsApi from '@/features/lab/api';
import type { CollapseWatchDTO, DriftCountdownDTO, DriftPointDTO } from '@/features/lab/types';
import { AgentDetail } from './AgentDetail';

const DRIFT: DriftPointDTO[] = [
  {
    capturedAt: '2026-08-10T00:00:00.000Z',
    distanceFromAnchor: 0.21,
    distanceFromPrev: 0.03,
    snapshotType: 'anchor',
    excerpt: 'first',
    aspects: { mode: 'aspect', values: 0.79, style: 0.81, topic: 0.68, breached: [] },
  },
  {
    capturedAt: '2026-08-18T00:00:00.000Z',
    distanceFromAnchor: 0.28,
    distanceFromPrev: 0.05,
    snapshotType: 'dream',
    excerpt: 'second',
    aspects: { mode: 'aspect', values: 0.74, style: 0.77, topic: 0.63, breached: ['topic'] },
  },
];

const COUNTDOWN: DriftCountdownDTO = {
  username: 'liushang',
  range: '7d',
  asOf: '2026-08-20T11:22:33.000Z',
  roundIntervalHours: 36,
  maxExtrapolation: 4,
  driftMode: 'aspect',
  gating: ['values', 'style', 'topic'],
  binding: null,
  series: (['anchor', 'values', 'style', 'topic'] as const).map((key, i) => ({
    key,
    n: 4 + i,
    latestSim: 0.7 + i / 100,
    latestAt: '2026-08-19T00:00:00.000Z',
    thresholdSim: [0.44, 0.55, 0.66, 0.61][i],
    thresholdBasis: 'event' as const,
    spanDays: 3 + i,
    simSlopePerDay: 0.001,
    r2: 0.5,
    crossesAt: null,
    roundsRemaining: null,
    crossedAlready: false,
    projection: 'not-declining' as const,
  })),
};

const COLLAPSE: CollapseWatchDTO = {
  username: 'liushang',
  since: '2026-08-13T00:00:00.000Z',
  until: '2026-08-20T00:00:00.000Z',
  minPoints: 5,
  similarityAvailableFrom: '2026-08-14T00:00:00.000Z',
  basis: 'length-only',
  verdict: 'shrinking',
  length: {
    key: 'length',
    unit: 'characters',
    n: 8,
    first: 41,
    firstAt: '2026-08-13T00:00:00.000Z',
    last: 22,
    lastAt: '2026-08-20T00:00:00.000Z',
    spanDays: 7,
    slopePerDay: -0.792009,
    slopeStdErr: 0.406654,
    r2: 0.387,
    trend: 'down',
    fit: 'fitted',
  },
  selfSimilarity: {
    key: 'selfSimilarity',
    unit: 'cosine-similarity',
    n: 0,
    first: null,
    firstAt: null,
    last: null,
    lastAt: null,
    spanDays: null,
    slopePerDay: null,
    slopeStdErr: null,
    r2: null,
    trend: null,
    fit: 'predates-instrument',
  },
};

function renderDetail(
  range: '7d' | '30d' | '90d' = '7d',
  countdown: DriftCountdownDTO = COUNTDOWN,
) {
  vi.mocked(agentsApi.getAgentDrift).mockResolvedValue(DRIFT);
  vi.mocked(agentsApi.getAgentEvents).mockResolvedValue([]);
  vi.mocked(agentsApi.getAgentFidelity).mockResolvedValue({ current: null, points: [] });
  vi.mocked(agentsApi.getAgentStats).mockResolvedValue({
    username: 'liushang',
    range: '30d',
    cadence: [],
    engagement: {
      selfPostsReceived: { likes: { byAi: 0, byHuman: 0 }, comments: { byAi: 0, byHuman: 0 } },
      given: { likes: { toAi: 0, toHuman: 0 }, comments: { toAi: 0, toHuman: 0 } },
    },
    topInteractors: [],
  });
  vi.mocked(agentsApi.getInfluences).mockResolvedValue({
    username: 'liushang',
    range: '30d',
    partners: [],
    activity: [],
    drift: [],
  });
  vi.mocked(agentsApi.getDriftCountdown).mockResolvedValue(countdown);
  vi.mocked(agentsApi.getCollapseWatch).mockResolvedValue(COLLAPSE);

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AgentDetail username="liushang" range={range} onClose={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AgentDetail — drift thresholds come off the wire', () => {
  it('shows the thresholds the newest measurement recorded, not a client constant', async () => {
    renderDetail();
    // 0.550 / 0.660 / 0.610 — the wire's values. The deleted constant held
    // 0.63 / 0.72 / 0.71, so a restored copy reddens this line.
    expect(
      await screen.findByText(
        /Reject thresholds in force: values 0\.550 · style 0\.660 · topic 0\.610/,
      ),
    ).toBeTruthy();
  });

  it('says "not recorded" for an aspect whose measurement carried no threshold', async () => {
    renderDetail('7d', {
      ...COUNTDOWN,
      series: COUNTDOWN.series.map((x) =>
        x.key === 'style' ? { ...x, thresholdSim: null, thresholdBasis: 'absent' as const } : x,
      ),
    });
    expect(
      await screen.findByText(
        /Reject thresholds in force: values 0\.550 · style not recorded · topic 0\.610/,
      ),
    ).toBeTruthy();
  });
});

describe('AgentDetail — the two panels', () => {
  it('mounts the countdown and the collapse watch', async () => {
    renderDetail();
    expect(await screen.findByText('Rounds until the gate locks it out')).toBeTruthy();
    expect(screen.getByText('Is its output rotting?')).toBeTruthy();
  });

  it('passes the page’s range to both, rather than the 30d the older charts use', async () => {
    renderDetail('7d');
    await screen.findByText('Rounds until the gate locks it out');
    // The WHOLE call list, not just its head. `AgentDetail` and the panel share
    // one query key deliberately, so exactly ONE request must go out — asserting
    // `calls[0]` alone would let the parent ask for a different range and be
    // hidden behind the child's effect, which runs first.
    expect(vi.mocked(agentsApi.getDriftCountdown).mock.calls).toEqual([['liushang', '7d']]);
    expect(vi.mocked(agentsApi.getCollapseWatch).mock.calls).toEqual([['liushang', '7d']]);
    // …while the charts above it stay pinned to their labelled 30 days.
    expect(vi.mocked(agentsApi.getAgentStats).mock.calls[0]).toEqual(['liushang', '30d']);
  });
});

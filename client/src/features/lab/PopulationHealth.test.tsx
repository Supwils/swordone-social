import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';

vi.mock('@/features/lab/api', () => ({
  getPopulationPulse: vi.fn(),
  getHomogenization: vi.fn(),
  listLabAgents: vi.fn(),
}));
vi.mock('./Sparkline', () => ({ Sparkline: () => null }));

import * as agentsApi from '@/features/lab/api';
import type { HomogenizationDTO, PulseDTO } from '@/features/lab/types';
import { makeLabAgent } from '@/test/fixtures';
import { PopulationHealth } from './PopulationHealth';

/**
 * Fixture rule (same as RuntimeHealth.test): every pinned number must be
 * distinguishable from anything the code could plausibly show instead.
 * range is 90d (never the 30d default); actions sum to 18; fidelity mean is
 * 0.820; diversity is 0.400; drift velocity 0.070 — all mutually distinct.
 */
function makePulse(): PulseDTO {
  return {
    range: '90d',
    points: [
      {
        date: '2026-08-18',
        posts: 2,
        comments: 3,
        likes: 2,
        actions: 7,
        meanFidelity: 0.8,
        meanDriftVelocity: 0.04,
      },
      {
        date: '2026-08-19',
        posts: 4,
        comments: 4,
        likes: 3,
        actions: 11,
        meanFidelity: 0.82,
        meanDriftVelocity: 0.07,
      },
    ],
  };
}

function makeHomog(behaviorCohesion = 0.6): HomogenizationDTO {
  return {
    current: { personaCohesion: 0.5, behaviorCohesion, n: 4 },
    points: [
      { capturedAt: '2026-08-18', personaCohesion: 0.5, behaviorCohesion: 0.58, n: 4 },
      { capturedAt: '2026-08-19', personaCohesion: 0.5, behaviorCohesion, n: 4 },
    ],
  };
}

const agents = [
  makeLabAgent({ username: 'a1', currentFidelity: 0.85 }),
  makeLabAgent({ username: 'a2', currentFidelity: 0.79 }),
];

function renderPanel(range: '7d' | '30d' | '90d' = '90d') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PopulationHealth era={2} range={range} agents={agents} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(agentsApi.getPopulationPulse).mockResolvedValue(makePulse());
  vi.mocked(agentsApi.getHomogenization).mockResolvedValue(makeHomog());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PopulationHealth', () => {
  it('computes the four golden signals from pulse + homogenization + fidelity', async () => {
    renderPanel('90d');

    // Activity: 7 + 11 actions in range.
    expect(await screen.findByText('18')).toBeTruthy();
    // Authenticity: mean of the agents' currentFidelity, not the pulse series.
    expect(screen.getByText('0.820')).toBeTruthy();
    // Diversity: 1 − current behavior cohesion (0.6).
    expect(screen.getByText('0.400')).toBeTruthy();
    // Stability: last non-null drift velocity.
    expect(screen.getByText('0.070')).toBeTruthy();

    expect(screen.getByText('Activity')).toBeTruthy();
    expect(screen.getByText('Authenticity')).toBeTruthy();
    expect(screen.getByText('Diversity')).toBeTruthy();
    expect(screen.getByText('Stability')).toBeTruthy();

    expect(agentsApi.getPopulationPulse).toHaveBeenCalledWith(2, '90d');
    expect(agentsApi.getHomogenization).toHaveBeenCalledWith(2, '90d');
  });

  it('rolls the worst health signal up into the composite verdict (warn)', async () => {
    renderPanel();

    // fidelity 0.820 good, diversity 0.400 good, drift 0.070 warn -> watch.
    expect(await screen.findByText('Population needs watching')).toBeTruthy();
  });

  it('goes critical when cohesion pushes diversity under the floor', async () => {
    vi.mocked(agentsApi.getHomogenization).mockResolvedValue(makeHomog(0.9));

    renderPanel();

    // diversity 0.100 -> bad, which outranks the drift warn.
    expect(await screen.findByText('Population critical')).toBeTruthy();
    expect(screen.getByText('0.100')).toBeTruthy();
  });
});

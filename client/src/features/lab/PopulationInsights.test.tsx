import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import '@/i18n';

vi.mock('@/api/agents', () => ({
  getAgentOverview: vi.fn(),
  getAlerts: vi.fn(),
  getHomogenization: vi.fn(),
  getPopulationPulse: vi.fn(),
  listLabAgents: vi.fn(),
}));

import * as agentsApi from '@/api/agents';
import { PopulationInsights } from './PopulationInsights';

type Agents = Awaited<ReturnType<typeof agentsApi.listLabAgents>>;
type Overview = Awaited<ReturnType<typeof agentsApi.getAgentOverview>>;

/**
 * Fixtures are tuned so exactly the intended conclusions fire:
 * - cohesion 0.500 -> 0.560 (delta +0.060 > 0.04) => monoculture "converging", bad
 * - fidelities clustered (0.79 worst, z ≈ -1.2) => off-character, NOT the
 *   z-outlier variant, tone warn (< 0.8)
 * - cohort medians 0.005 apart => cohort-gap conclusion must NOT fire
 * - drift top 0.120 (z ≈ 1.3) => "wandered furthest", NOT the outlier variant
 * - empty pulse/alerts => activity + dream conclusions must NOT fire
 * - two echo flags => echo roll-up with both handles
 */
const agents = [
  { username: 'steady1', isAgent: true, currentFidelity: 0.8, currentDriftFromAnchor: 0.1 },
  { username: 'steady2', isAgent: true, currentFidelity: 0.82, currentDriftFromAnchor: 0.09 },
  { username: 'lowfid', isAgent: false, currentFidelity: 0.79, currentDriftFromAnchor: 0.11 },
  { username: 'wanderer', isAgent: false, currentFidelity: 0.84, currentDriftFromAnchor: 0.12 },
] as unknown as Agents;

function Harness({ onSelect }: { onSelect: (u: string) => void }) {
  const overviewQ = useQuery({
    queryKey: ['test-overview'],
    queryFn: () => agentsApi.getAgentOverview(),
    retry: false,
  });
  return <PopulationInsights overviewQ={overviewQ} agents={agents} range="30d" onSelect={onSelect} />;
}

function renderPanel(onSelect: (u: string) => void = () => undefined) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Harness onSelect={onSelect} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(agentsApi.getAgentOverview).mockResolvedValue({
    echoChamberFlags: ['qbot', 'rbot'],
  } as unknown as Overview);
  vi.mocked(agentsApi.getHomogenization).mockResolvedValue({
    current: { personaCohesion: 0.5, behaviorCohesion: 0.56, n: 4 },
    points: [
      { capturedAt: '2026-08-01', personaCohesion: 0.5, behaviorCohesion: 0.5, n: 4 },
      { capturedAt: '2026-08-20', personaCohesion: 0.5, behaviorCohesion: 0.56, n: 4 },
    ],
  });
  vi.mocked(agentsApi.getPopulationPulse).mockResolvedValue({ range: '30d', points: [] });
  vi.mocked(agentsApi.getAlerts).mockResolvedValue({ range: '30d', alerts: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PopulationInsights', () => {
  it('pins the monoculture verdict first with the cohesion evidence', async () => {
    renderPanel();

    expect(await screen.findByText('Voices are converging')).toBeTruthy();
    expect(screen.getByText(/behaviour cohesion 0\.560/)).toBeTruthy();

    const rows = screen.getAllByRole('button');
    expect(rows[0].textContent).toContain('Voices are converging');
  });

  it('names the least-in-character account and the biggest drifter', async () => {
    renderPanel();

    expect(await screen.findByText('@lowfid acts least like itself')).toBeTruthy();
    expect(screen.getByText('fidelity 0.790 — posts diverge from its bio')).toBeTruthy();

    expect(screen.getByText('@wanderer wandered furthest')).toBeTruthy();
    expect(screen.getByText('0.120 from its original self')).toBeTruthy();

    // Fixture medians differ by 0.005, under the 0.03 gate: no cohort row.
    expect(screen.queryByText(/cohort/i)).toBeNull();
  });

  it('rolls echo-chamber flags into one conclusion listing the handles', async () => {
    renderPanel();

    expect(await screen.findByText('@qbot · @rbot')).toBeTruthy();
  });

  it('focuses the named account when a conclusion is clicked', async () => {
    const onSelect = vi.fn();
    renderPanel(onSelect);

    fireEvent.click(await screen.findByText('@wanderer wandered furthest'));
    expect(onSelect).toHaveBeenCalledWith('wanderer');
  });
});

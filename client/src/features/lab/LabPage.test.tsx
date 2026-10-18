import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import '@/i18n';
import { makeLabAgent } from '@/test/fixtures';

vi.mock('@/features/lab/api', () => ({
  getAgentOverview: vi.fn(),
  getInteractionGraph: vi.fn(),
  listLabAgents: vi.fn(),
}));

vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('@/features/lab/RuntimeHealth', () => ({ RuntimeHealth: () => null }));
vi.mock('@/features/lab/PopulationHealth', () => ({ PopulationHealth: () => null }));
vi.mock('@/features/lab/era2/DistributionPanel', () => ({ DistributionPanel: () => null }));
vi.mock('@/features/lab/BenchmarkView', () => ({ BenchmarkView: () => <div>bench-panel</div> }));
vi.mock('@/features/lab/era2/CrossSpeciesPanel', () => ({ CrossSpeciesPanel: () => null }));
vi.mock('@/features/lab/GraphView', () => ({
  GraphView: ({ era }: { era: number }) => <div>graph-panel era={era}</div>,
  AlertsStrip: () => null,
}));
vi.mock('@/features/lab/era2/PopulationInsights', () => ({
  PopulationInsights: ({ era }: { era: number }) => <div>era2-insights era={era}</div>,
}));
vi.mock('@/features/lab/era3/Era3Dashboard', () => ({
  Era3Dashboard: ({ detail }: { detail?: ReactNode }) => (
    <div>
      era3-dashboard
      {detail}
    </div>
  ),
}));
vi.mock('@/features/lab/era3/Era3AgentDetail', () => ({
  Era3AgentDetail: ({
    username,
    agent,
    onClose,
  }: {
    username: string;
    agent?: { displayName: string };
    onClose: () => void;
  }) => (
    <div>
      era3-detail @{username} {agent?.displayName}
      <button type="button" onClick={onClose}>
        close-era3
      </button>
    </div>
  ),
}));
vi.mock('@/features/lab/HomogenizationPanel', () => ({ HomogenizationPanel: () => null }));
vi.mock('@/features/lab/era2/Overview', () => ({ Overview: () => null }));
vi.mock('@/features/lab/AgentGrid', () => ({ AgentGrid: () => <div data-testid="agent-grid" /> }));
vi.mock('@/features/lab/era2/AgentDetail', () => ({
  AgentDetail: ({ username }: { username: string }) => <div>detail @{username}</div>,
}));

import * as agentsApi from '@/features/lab/api';
import LabPage from './LabPage';

function LocationProbe() {
  const loc = useLocation();
  return (
    <>
      <output data-testid="search">{loc.search}</output>
      <output data-testid="pathname">{loc.pathname}</output>
    </>
  );
}

function renderLab(
  path = '/lab',
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const view = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <LabPage />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, qc };
}

function search(): URLSearchParams {
  return new URLSearchParams(screen.getByTestId('search').textContent ?? '');
}

function mockReads() {
  vi.mocked(agentsApi.listLabAgents).mockResolvedValue([]);
  vi.mocked(agentsApi.getAgentOverview).mockResolvedValue({} as never);
  vi.mocked(agentsApi.getInteractionGraph).mockResolvedValue({ nodes: [], edges: [] } as never);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('LabPage', () => {
  it('renders the lab title, tabs, and the roster count from the wire', async () => {
    vi.mocked(agentsApi.listLabAgents).mockResolvedValue([
      makeLabAgent({ username: 'liushang' }),
      makeLabAgent({ username: 'qiusai' }),
    ]);
    vi.mocked(agentsApi.getAgentOverview).mockResolvedValue({} as never);
    vi.mocked(agentsApi.getInteractionGraph).mockResolvedValue({ nodes: [], edges: [] } as never);

    renderLab();

    expect(await screen.findByRole('heading', { name: 'Agent Lab' })).toBeTruthy();
    expect(await screen.findByText(/Watching 2 AI/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Overview' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Who talks to whom' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Model bench' })).toBeTruthy();
  });

  it('switches to the benchmark view from the tab', async () => {
    vi.mocked(agentsApi.listLabAgents).mockResolvedValue([]);
    vi.mocked(agentsApi.getAgentOverview).mockResolvedValue({} as never);
    vi.mocked(agentsApi.getInteractionGraph).mockResolvedValue({ nodes: [], edges: [] } as never);

    renderLab();
    await screen.findByRole('heading', { name: 'Agent Lab' });
    const overview = screen.getByRole('button', { name: 'Overview' });
    const bench = screen.getByRole('button', { name: 'Model bench' });
    expect(overview.getAttribute('aria-pressed')).toBe('true');
    expect(bench.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(bench);

    expect(await screen.findByText('bench-panel')).toBeTruthy();
    expect(bench.getAttribute('aria-pressed')).toBe('true');
    expect(overview.getAttribute('aria-pressed')).toBe('false');
  });

  it('exposes the range and live toggles as pressed buttons', async () => {
    vi.mocked(agentsApi.listLabAgents).mockResolvedValue([]);
    vi.mocked(agentsApi.getAgentOverview).mockResolvedValue({} as never);
    vi.mocked(agentsApi.getInteractionGraph).mockResolvedValue({ nodes: [], edges: [] } as never);

    renderLab('/lab?range=7d');
    await screen.findByRole('heading', { name: 'Agent Lab' });

    expect(screen.getByRole('button', { name: '7 days' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: '30 days' }).getAttribute('aria-pressed')).toBe(
      'false',
    );

    const live = screen.getByRole('button', { name: /Live/ });
    expect(live.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(live);
    expect(live.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('LabPage — era switch', () => {
  const era3 = () => screen.getByRole('button', { name: 'Era 3 · model-native' });
  const era2 = () => screen.getByRole('button', { name: 'Era 2 · sealed' });

  it('defaults to Era 3 with no era param and reads the live roster', async () => {
    mockReads();
    renderLab();

    expect(await screen.findByText('era3-dashboard')).toBeTruthy();
    expect(era3().getAttribute('aria-pressed')).toBe('true');
    expect(era2().getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByText(/era2-insights/)).toBeNull();
    expect(vi.mocked(agentsApi.listLabAgents).mock.calls[0]).toEqual([3, 100]);
    // The Era 2 overview and cross-species graph are not fetched for Era 3.
    expect(agentsApi.getAgentOverview).not.toHaveBeenCalled();
    expect(agentsApi.getInteractionGraph).not.toHaveBeenCalled();
  });

  it('treats an unknown era value as Era 3', async () => {
    mockReads();
    renderLab('/lab?era=5');

    expect(await screen.findByText('era3-dashboard')).toBeTruthy();
    expect(era3().getAttribute('aria-pressed')).toBe('true');
    expect(vi.mocked(agentsApi.listLabAgents).mock.calls[0]).toEqual([3, 100]);
  });

  it('renders today’s dashboard for era=2 and passes the era to every read', async () => {
    mockReads();
    const { qc } = renderLab('/lab?era=2&agent=liushang');

    expect(await screen.findByText('era2-insights era=2')).toBeTruthy();
    expect(screen.getByText('detail @liushang')).toBeTruthy();
    expect(screen.queryByText('era3-dashboard')).toBeNull();
    expect(era2().getAttribute('aria-pressed')).toBe('true');
    expect(vi.mocked(agentsApi.listLabAgents).mock.calls[0]).toEqual([2, 100]);
    await vi.waitFor(() => expect(agentsApi.getInteractionGraph).toHaveBeenCalledWith(2, '30d'));
    expect(agentsApi.getAgentOverview).toHaveBeenCalledWith(2);

    // Every era-aware cache entry is keyed on the era.
    const keys = qc
      .getQueryCache()
      .findAll()
      .map((q) => q.queryKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        ['lab-agents', 2],
        ['lab-overview', 2],
        ['lab-graph', 2, '30d'],
      ]),
    );
  });

  it('switching era round-trips the URL, clears the focused account, keeps view and range', async () => {
    mockReads();
    renderLab('/lab?era=2&agent=liushang&range=7d');
    await screen.findByText('era2-insights era=2');

    fireEvent.click(era3());
    expect(await screen.findByText('era3-dashboard')).toBeTruthy();
    expect(search().has('era')).toBe(false);
    expect(search().has('agent')).toBe(false);
    expect(search().get('range')).toBe('7d');
    expect(era3().getAttribute('aria-pressed')).toBe('true');
    expect(vi.mocked(agentsApi.listLabAgents).mock.calls.at(-1)).toEqual([3, 100]);

    fireEvent.click(era2());
    expect(await screen.findByText('era2-insights era=2')).toBeTruthy();
    expect(search().get('era')).toBe('2');
    expect(search().get('range')).toBe('7d');
    expect(screen.queryByText(/detail @/)).toBeNull();
  });

  it('keeps the graph tab on switch and threads the era into it', async () => {
    mockReads();
    renderLab('/lab?view=graph');

    expect(await screen.findByText('graph-panel era=3')).toBeTruthy();
    fireEvent.click(era2());
    expect(await screen.findByText('graph-panel era=2')).toBeTruthy();
    expect(search().get('view')).toBe('graph');
    expect(search().get('era')).toBe('2');
  });
});

describe('LabPage — stays on its own path', () => {
  it('era and view switches on /lab/v1 never leave /lab/v1', async () => {
    mockReads();
    renderLab('/lab/v1?era=2&view=graph');
    await screen.findByText('graph-panel era=2');

    fireEvent.click(screen.getByRole('button', { name: 'Era 3 · model-native' }));
    expect(await screen.findByText('graph-panel era=3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Overview' }));
    expect(await screen.findByText('era3-dashboard')).toBeTruthy();
    expect(screen.getByTestId('pathname').textContent).toBe('/lab/v1');
    expect(search().has('view')).toBe(false);
  });
});

describe('LabPage — focused account', () => {
  const live = (username: string, archivedAt: string | null = null) =>
    makeLabAgent({ username, displayName: `name-${username}`, archivedAt, arm: 'claude-opus' });

  it('routes ?agent= to the Era 3 detail for a live roster account', async () => {
    mockReads();
    vi.mocked(agentsApi.listLabAgents).mockResolvedValue([live('agen'), live('xiaoyu')]);
    renderLab('/lab?agent=agen');

    expect(await screen.findByText(/era3-detail @agen name-agen/)).toBeTruthy();
    expect(screen.queryByText(/^detail @/)).toBeNull();
  });

  it('routes ?agent= to the Era 2 detail in Era 2', async () => {
    mockReads();
    vi.mocked(agentsApi.listLabAgents).mockResolvedValue([
      live('liushang', '2026-10-14T00:00:00Z'),
    ]);
    renderLab('/lab?era=2&agent=liushang');

    expect(await screen.findByText('detail @liushang')).toBeTruthy();
    expect(screen.queryByText(/era3-detail/)).toBeNull();
  });

  it('renders no detail for a username outside the Era 3 roster and keeps the param', async () => {
    mockReads();
    vi.mocked(agentsApi.listLabAgents).mockResolvedValue([
      live('agen'),
      live('liushang', '2026-10-14T00:00:00Z'),
    ]);
    renderLab('/lab?agent=ghost');
    await screen.findByText(/Watching 2 AI/);

    expect(screen.queryByText(/era3-detail/)).toBeNull();
    expect(screen.queryByText(/^detail @/)).toBeNull();
    expect(search().get('agent')).toBe('ghost');
  });

  it('renders no Era 3 detail for an archived account', async () => {
    mockReads();
    vi.mocked(agentsApi.listLabAgents).mockResolvedValue([
      live('agen'),
      live('liushang', '2026-10-14T00:00:00Z'),
    ]);
    renderLab('/lab?agent=liushang');
    await screen.findByText(/Watching 2 AI/);

    expect(screen.queryByText(/era3-detail/)).toBeNull();
    expect(search().get('agent')).toBe('liushang');
  });

  it('closing the Era 3 detail clears the agent param', async () => {
    mockReads();
    vi.mocked(agentsApi.listLabAgents).mockResolvedValue([live('agen')]);
    renderLab('/lab?agent=agen&range=7d');

    fireEvent.click(await screen.findByRole('button', { name: 'close-era3' }));
    expect(search().has('agent')).toBe(false);
    expect(search().get('range')).toBe('7d');
    expect(screen.queryByText(/era3-detail/)).toBeNull();
  });
});

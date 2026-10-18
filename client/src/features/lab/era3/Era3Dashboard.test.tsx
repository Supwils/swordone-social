/**
 * The Era 3 dashboard fetches the arms report once and lays out, in order:
 * experiment header → three metric panels → exploratory → alerts → runtime →
 * homogenization → roster. Every shared panel must stay scoped to Era 3: a
 * panel left on its own default would show the sealed population under the
 * live header.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import '@/i18n';

vi.mock('@/features/lab/api', () => ({ getArmsReport: vi.fn() }));
vi.mock('@/features/lab/GraphView', () => ({
  AlertsStrip: ({ era }: { era: number }) => <div>alerts era={era}</div>,
}));
vi.mock('@/features/lab/RuntimeHealth', () => ({
  RuntimeHealth: ({ era, range }: { era: number; range: string }) => (
    <div>
      runtime era={era} range={range}
    </div>
  ),
}));
vi.mock('@/features/lab/HomogenizationPanel', () => ({
  HomogenizationPanel: ({ era, range }: { era: number; range: string }) => (
    <div>
      homog era={era} range={range}
    </div>
  ),
}));
vi.mock('@/features/lab/AgentGrid', () => ({
  AgentGrid: ({
    agents,
    focusedUsername,
    onFocus,
  }: {
    agents: Array<{ username: string }>;
    focusedUsername: string | null;
    onFocus: (u: string) => void;
  }) => (
    <button type="button" onClick={() => onFocus(agents[0].username)}>
      grid {agents.length} focused={focusedUsername ?? 'none'}
    </button>
  ),
}));

import * as labApi from '@/features/lab/api';
import { makeLabAgent } from '@/test/fixtures';
import { Era3Dashboard } from './Era3Dashboard';
import { emptyReport, seededReport } from '../metrics/testFixtures';

const AGENTS = [
  makeLabAgent({ username: 'xiaoman', arm: 'claude-haiku' }),
  makeLabAgent({ username: 'awen', arm: 'grok' }),
];

function renderDashboard(onFocus = vi.fn(), detail?: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Era3Dashboard
        range="90d"
        agents={AGENTS}
        loading={false}
        focusedUsername="awen"
        onFocus={onFocus}
        detail={detail}
      />
    </QueryClientProvider>,
  );
  return onFocus;
}

function before(a: HTMLElement, b: HTMLElement): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Era3Dashboard', () => {
  it('lays out header, metrics, exploratory, then the Era 3 shared panels and the roster', async () => {
    vi.mocked(labApi.getArmsReport).mockResolvedValue(seededReport());
    const onFocus = renderDashboard();

    const header = await screen.findByText('Era 3 experiment');
    const [, fidelityPanel] = screen.getAllByText('(a) Fidelity decay');
    const [, repetitionPanel] = screen.getAllByText('(b) Self-repetition');
    const [, convergencePanel] = screen.getAllByText('(c) Convergence');
    const exploratory = screen.getByText('Exploratory — no decision rule');
    const alerts = screen.getByText('alerts era=3');
    const runtime = screen.getByText('runtime era=3 range=90d');
    const homog = screen.getByText('homog era=3 range=90d');
    const grid = screen.getByText('grid 2 focused=awen');

    const order = [
      header,
      fidelityPanel,
      repetitionPanel,
      convergencePanel,
      exploratory,
      alerts,
      runtime,
      homog,
      grid,
    ];
    for (let i = 1; i < order.length; i++) expect(before(order[i - 1], order[i])).toBe(true);

    // One shared report query feeds the header and every panel.
    expect(labApi.getArmsReport).toHaveBeenCalledTimes(1);

    fireEvent.click(grid);
    expect(onFocus).toHaveBeenCalledWith('xiaoman');
  });

  it('renders a zero-round report as collecting without crashing', async () => {
    vi.mocked(labApi.getArmsReport).mockResolvedValue(emptyReport());
    renderDashboard();
    await screen.findByText('Era 3 experiment');
    // Three verdict lines in the header, one per metric panel.
    expect(screen.getAllByText('Collecting — 0/12 rounds; values are provisional')).toHaveLength(6);
    expect(
      screen.getByText('Collecting — the first two sweeps form the vocabulary baseline.'),
    ).toBeTruthy();
  });

  it('keeps the shared panels when the arms report fails', async () => {
    vi.mocked(labApi.getArmsReport).mockRejectedValue(new Error('boom'));
    renderDashboard();
    expect(await screen.findByText('Could not load the experiment report.')).toBeTruthy();
    expect(screen.getByText('alerts era=3')).toBeTruthy();
    expect(screen.getByText('grid 2 focused=awen')).toBeTruthy();
  });

  it('renders the focused account detail between homogenization and the roster', async () => {
    vi.mocked(labApi.getArmsReport).mockResolvedValue(seededReport());
    renderDashboard(vi.fn(), <div>detail-slot</div>);
    await screen.findByText('Era 3 experiment');

    const homog = screen.getByText('homog era=3 range=90d');
    const detail = screen.getByText('detail-slot');
    const grid = screen.getByText('grid 2 focused=awen');
    expect(before(homog, detail)).toBe(true);
    expect(before(detail, grid)).toBe(true);
  });
});

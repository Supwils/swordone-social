/**
 * `Era3AgentDetail` — the per-account view for a live Era 3 account.
 *
 * Fixture numbers are all distinct (no two cells share a value) so a cell that
 * printed its neighbour's field shows up as a missing or duplicated string.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import '@/i18n';

vi.mock('@/features/lab/api', () => ({
  getAccountRounds: vi.fn(),
  getAgentDrift: vi.fn(),
}));
vi.mock('@/features/lab/CollapsePanel', () => ({
  CollapsePanel: ({ username, range }: { username: string; range: string }) => (
    <div>
      collapse @{username} {range}
    </div>
  ),
}));
// Print the series instead of drawing it, so order and filtering are assertable.
vi.mock('@/features/lab/Sparkline', () => ({
  Sparkline: ({ data, domain }: { data: Array<{ v: number }>; domain?: [number, number] }) => (
    <output data-testid="spark" data-domain={domain?.join(',')}>
      {data.map((p) => p.v).join(',')}
    </output>
  ),
}));

import * as labApi from '@/features/lab/api';
import type { AccountRoundsDTO, DriftPointDTO } from '@/features/lab/types';
import { makeLabAgent } from '@/test/fixtures';
import { Era3AgentDetail } from './Era3AgentDetail';

const ROUNDS: AccountRoundsDTO = {
  username: 'agen',
  arm: 'claude-opus',
  rounds: [
    // Newest first, as the server sends them.
    {
      roundId: '20261019T060000Z-r',
      kind: 'sweep',
      startedAt: '2026-10-19T06:00:00.000Z',
      outcome: 'success',
      actOutcome: 'posted',
      attempted: 3,
      landed: 2,
      dreamAccepted: true,
      candidate: { maxSim: 0.812, cardSim: 0.703, dropped: false },
      post: { postId: 'p3', cardSim: 0.691, convergence: 0.604 },
    },
    {
      roundId: '20261018T101500Z-m',
      kind: 'manual',
      startedAt: '2026-10-18T10:15:00.000Z',
      outcome: 'success',
      actOutcome: 'interacted',
      attempted: 1,
      landed: 1,
      dreamAccepted: false,
      candidate: { maxSim: 0.934, cardSim: null, dropped: true },
      post: null,
    },
    {
      roundId: '20261017T060000Z-r',
      kind: 'sweep',
      startedAt: '2026-10-17T06:00:00.000Z',
      outcome: 'fail',
      actOutcome: null,
      attempted: null,
      landed: null,
      dreamAccepted: null,
      candidate: null,
      post: { postId: 'p1', cardSim: 0.722, convergence: null },
    },
    {
      roundId: '20261015T060000Z-r',
      kind: 'sweep',
      startedAt: '2026-10-15T06:00:00.000Z',
      outcome: 'success',
      actOutcome: 'posted',
      attempted: 2,
      landed: 2,
      dreamAccepted: true,
      candidate: { maxSim: 0.455, cardSim: 0.716, dropped: false },
      post: { postId: 'p0', cardSim: 0.744, convergence: 0.588 },
    },
  ],
};

const DRIFT: DriftPointDTO[] = [
  {
    capturedAt: '2026-10-14T08:00:00.000Z',
    distanceFromAnchor: 0,
    distanceFromPrev: 0,
    snapshotType: 'anchor',
    excerpt: 'anchor card text',
  },
  {
    capturedAt: '2026-10-17T07:00:00.000Z',
    distanceFromAnchor: 0.041,
    distanceFromPrev: 0.041,
    snapshotType: 'dream',
    excerpt: '最近：在修一把旧椅子',
  },
];

const AGENT = makeLabAgent({
  username: 'agen',
  displayName: '阿根',
  agentBackend: 'claude:claude-opus-5-5',
  arm: 'claude-opus',
});

function renderDetail(props: Partial<Parameters<typeof Era3AgentDetail>[0]> = {}) {
  const onClose = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Era3AgentDetail username="agen" onClose={onClose} agent={AGENT} {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, onClose, qc };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Era3AgentDetail', () => {
  it('renders the header and the seeded rounds newest first with real numbers', async () => {
    vi.mocked(labApi.getAccountRounds).mockResolvedValue(ROUNDS);
    vi.mocked(labApi.getAgentDrift).mockResolvedValue(DRIFT);
    const { qc } = renderDetail();

    expect(screen.getByRole('heading', { name: /阿根/ })).toBeTruthy();
    expect(screen.getByText('@agen')).toBeTruthy();
    expect(screen.getByText('claude:claude-opus-5-5')).toBeTruthy();

    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0].textContent)).toEqual([
      '20261019T060000Z-r',
      '20261018T101500Z-m',
      '20261017T060000Z-r',
      '20261015T060000Z-r',
    ]);

    const cells = (i: number) =>
      within(rows[i])
        .getAllByRole('cell')
        .map((c) => c.textContent);
    // round, kind, outcome, act, attempted/landed, dream, maxSim, cardSim, dropped, post cardSim, convergence
    expect(cells(0)).toEqual([
      '20261019T060000Z-r',
      'sweep',
      'success',
      'posted',
      '3 / 2',
      '✓',
      '0.812',
      '0.703',
      '—',
      '0.691',
      '0.604',
    ]);
    expect(cells(1)).toEqual([
      '20261018T101500Z-m',
      'manual',
      'success',
      'interacted',
      '1 / 1',
      '✗',
      '0.934',
      '—',
      'dropped',
      '—',
      '—',
    ]);
    // Every missing field is a dash, never "null", "NaN" or "undefined".
    expect(cells(2)).toEqual([
      '20261017T060000Z-r',
      'sweep',
      'fail',
      '—',
      '— / —',
      '—',
      '—',
      '—',
      '—',
      '0.722',
      '—',
    ]);
    expect(table.textContent).not.toMatch(/null|NaN|undefined/);

    // The table scrolls in its own box at phone width.
    expect(table.parentElement?.getAttribute('data-scroll')).toBe('x');

    // Sparklines are chronological (oldest first) and skip rounds with no value.
    const [cardSpark, selfSpark] = screen.getAllByTestId('spark');
    expect(cardSpark.textContent).toBe('0.744,0.722,0.691');
    expect(selfSpark.textContent).toBe('0.455,0.934,0.812');
    // Similarities share a fixed [0, 1] scale, so two accounts' shapes compare.
    expect(cardSpark.getAttribute('data-domain')).toBe('0,1');
    expect(selfSpark.getAttribute('data-domain')).toBe('0,1');

    // 最近 history: newest snapshot first, with its type and date.
    const recent = screen.getByTestId('recent-history');
    const items = within(recent).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('最近：在修一把旧椅子');
    expect(items[0].textContent).toContain('dream');
    expect(items[0].textContent).toContain('2026-10-17');
    expect(items[1].textContent).toContain('anchor');

    expect(screen.getByText('collapse @agen 30d')).toBeTruthy();
    expect(screen.getByText(/every other roster account in the round/)).toBeTruthy();

    const keys = qc
      .getQueryCache()
      .findAll()
      .map((q) => q.queryKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        ['lab-account-rounds', 'agen'],
        ['agent-drift', 'agen'],
      ]),
    );
  });

  it('shows the empty state for an account with no rounds yet', async () => {
    vi.mocked(labApi.getAccountRounds).mockResolvedValue({
      username: 'agen',
      arm: 'claude-opus',
      rounds: [],
    });
    vi.mocked(labApi.getAgentDrift).mockResolvedValue([]);
    renderDetail({ range: '7d' });

    expect(await screen.findByText(/No rounds yet/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(await screen.findByText(/No 最近 snapshots yet/)).toBeTruthy();
    expect(screen.getByText('collapse @agen 7d')).toBeTruthy();
  });

  it('falls back to the rounds payload for the header when no roster entry is passed', async () => {
    vi.mocked(labApi.getAccountRounds).mockResolvedValue({ ...ROUNDS, arm: null });
    vi.mocked(labApi.getAgentDrift).mockResolvedValue([]);
    renderDetail({ agent: undefined });

    expect(await screen.findByRole('table')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /@agen/ })).toBeTruthy();
    expect(screen.getByText('No arm')).toBeTruthy();
  });

  it('shows an error when the rounds read fails', async () => {
    vi.mocked(labApi.getAccountRounds).mockRejectedValue(new Error('boom'));
    vi.mocked(labApi.getAgentDrift).mockRejectedValue(new Error('boom'));
    renderDetail();

    expect(await screen.findByText(/Could not load this account's rounds/)).toBeTruthy();
    expect(await screen.findByText(/Could not load the 最近 history/)).toBeTruthy();
  });

  it('calls onClose from the close button', async () => {
    vi.mocked(labApi.getAccountRounds).mockResolvedValue(ROUNDS);
    vi.mocked(labApi.getAgentDrift).mockResolvedValue(DRIFT);
    const { onClose } = renderDetail();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

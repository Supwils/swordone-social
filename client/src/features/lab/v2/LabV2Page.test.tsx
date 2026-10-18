import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import '@/i18n';
import { makeLabAgent } from '@/test/fixtures';
import { seededReport } from '@/features/lab/metrics/testFixtures';

vi.mock('@/features/lab/api', () => ({
  listRounds: vi.fn(),
  getRoundDigest: vi.fn(),
  getArmsReport: vi.fn(),
  listLabAgents: vi.fn(),
}));
vi.mock('@/features/lab/metrics/ArmsMetrics', () => ({
  ArmsMetrics: () => <div>arms-metrics</div>,
}));
vi.mock('@/features/lab/era3/ArmRoster', () => ({
  ArmRoster: ({ onFocus }: { onFocus: (u: string) => void }) => (
    <button type="button" onClick={() => onFocus('awen')}>
      roster
    </button>
  ),
}));
vi.mock('@/features/lab/era3/Era3AgentDetail', () => ({
  Era3AgentDetail: ({ username, onClose }: { username: string; onClose: () => void }) => (
    <div>
      detail @{username}
      <button type="button" onClick={onClose}>
        close-detail
      </button>
    </div>
  ),
}));

import * as api from '@/features/lab/api';
import LabV2Page from './LabV2Page';
import { MANUAL_ID, makeDigest, makeRounds, SWEEP_ID } from './testFixtures';

/** The sweep's heading carries its ordinal; the manual round has none. */
const SWEEP_TITLE = `Round 1 · ${SWEEP_ID}`;
const MANUAL_TITLE = `Round ${MANUAL_ID}`;

function Probe() {
  const loc = useLocation();
  return <output data-testid="search">{loc.search}</output>;
}

function renderPage(path = '/lab') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <LabV2Page />
        <Probe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function wire({ rounds = makeRounds() } = {}) {
  vi.mocked(api.listRounds).mockResolvedValue(rounds);
  vi.mocked(api.getRoundDigest).mockImplementation(async (id) => {
    const base = makeDigest().round;
    const listed = rounds.rounds.find((r) => r.roundId === id);
    return makeDigest({
      round: listed
        ? { ...base, roundId: id, kind: listed.kind, ordinal: listed.ordinal }
        : { ...base, roundId: id },
    });
  });
  vi.mocked(api.getArmsReport).mockResolvedValue(seededReport());
  vi.mocked(api.listLabAgents).mockResolvedValue([
    makeLabAgent({ username: 'awen', arm: 'grok' }),
    makeLabAgent({ username: 'xiaoman', arm: 'claude-haiku' }),
    makeLabAgent({ username: 'oldie', arm: null, archivedAt: '2026-10-14T00:00:00.000Z' }),
  ]);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('LabV2Page', () => {
  it('shows the round’s observer note between the digest and the storylines', async () => {
    wire();
    vi.mocked(api.getRoundDigest).mockResolvedValue(
      makeDigest({
        observation: {
          text: 'a note',
          model: 'claude-opus-5-5',
          digestHash: 'a'.repeat(64),
          stale: false,
          updatedAt: '2026-10-17T08:00:00.000Z',
        },
      }),
    );
    renderPage();
    const note = await screen.findByText('a note');
    expect(
      screen.getByText('Machine observation · claude-opus-5-5 · not a conclusion'),
    ).toBeTruthy();
    const digest = screen.getByRole('heading', { name: SWEEP_TITLE });
    const storylines = screen.getByRole('heading', { name: 'Storylines' });
    // FOLLOWING: the argument comes after the node it is called on, in document order.
    expect(digest.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      note.compareDocumentPosition(storylines) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('opens the newest SWEEP round by default, not a newer manual one', async () => {
    wire();
    renderPage();
    expect(await screen.findByRole('heading', { name: SWEEP_TITLE })).toBeTruthy();
    expect(api.getRoundDigest).toHaveBeenCalledWith(SWEEP_ID);
    expect(screen.getByText('arms-metrics')).toBeTruthy();
  });

  it('?round= selects a round and the picker writes it back to the URL', async () => {
    wire();
    renderPage(`/lab?round=${MANUAL_ID}`);
    expect(await screen.findByRole('heading', { name: MANUAL_TITLE })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Round'), { target: { value: SWEEP_ID } });
    await waitFor(() =>
      expect(screen.getByTestId('search').textContent).toBe(
        `?round=${encodeURIComponent(SWEEP_ID)}`,
      ),
    );
  });

  it('an empty round list says so and fetches no digest', async () => {
    wire({ rounds: { rounds: [] } });
    renderPage();
    expect(await screen.findByText('No completed rounds yet')).toBeTruthy();
    expect(api.getRoundDigest).not.toHaveBeenCalled();
  });

  it.each([404, 400])('a %s round shows a notice with a way back to the newest', async (status) => {
    wire();
    vi.mocked(api.getRoundDigest).mockRejectedValueOnce({
      code: 'NOT_FOUND',
      message: 'x',
      status,
    });
    renderPage('/lab?round=20991231T000000Z-r');
    expect(await screen.findByText('That round does not exist.')).toBeTruthy();
    expect(api.getRoundDigest).toHaveBeenCalledTimes(1); // no retries
    fireEvent.click(screen.getByRole('button', { name: 'Back to the newest round' }));
    expect(await screen.findByRole('heading', { name: SWEEP_TITLE })).toBeTruthy();
    expect(screen.getByTestId('search').textContent).toBe('');
  });

  it('any other failure offers a retry that refetches', async () => {
    wire();
    vi.mocked(api.getRoundDigest).mockRejectedValueOnce({
      code: 'INTERNAL',
      message: 'x',
      status: 500,
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: SWEEP_TITLE })).toBeTruthy();
    expect(api.getRoundDigest).toHaveBeenCalledTimes(2);
  });

  it('?agent= opens a live roster account’s story; closing drops the param', async () => {
    wire();
    renderPage('/lab?agent=xiaoman');
    expect(await screen.findByText('detail @xiaoman')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'close-detail' }));
    await waitFor(() => expect(screen.getByTestId('search').textContent).toBe(''));
  });

  it('an archived or unknown ?agent= opens nothing and keeps the param', async () => {
    wire();
    renderPage('/lab?agent=oldie');
    await screen.findByRole('heading', { name: SWEEP_TITLE });
    expect(screen.queryByText(/detail @/)).toBeNull();
    expect(screen.getByTestId('search').textContent).toBe('?agent=oldie');
  });

  it('links the Persona Bench and the older view on /lab/v1', async () => {
    wire();
    renderPage();
    await screen.findByRole('heading', { name: SWEEP_TITLE });
    expect(screen.getByRole('link', { name: 'Persona Bench' }).getAttribute('href')).toBe(
      '/lab/v1?view=benchmark',
    );
    expect(screen.getByRole('link', { name: 'Older view' }).getAttribute('href')).toBe('/lab/v1');
    expect(screen.getByRole('navigation', { name: 'Other lab views' })).toBeTruthy();
  });

  it('an empty ?round= opens the newest sweep round and never asks for an empty id', async () => {
    wire();
    renderPage('/lab?round=');
    expect(await screen.findByRole('heading', { name: SWEEP_TITLE })).toBeTruthy();
    expect(api.getRoundDigest).toHaveBeenCalledWith(SWEEP_ID);
    expect(api.getRoundDigest).not.toHaveBeenCalledWith('');
  });

  it('shows a loading skeleton while the round list is in flight', async () => {
    wire();
    vi.mocked(api.listRounds).mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(await screen.findByRole('status', { name: 'Loading the round…' })).toBeTruthy();
    expect(api.getRoundDigest).not.toHaveBeenCalled();
  });

  it('a failed round list offers a retry that refetches it', async () => {
    wire();
    vi.mocked(api.listRounds).mockRejectedValueOnce({
      code: 'INTERNAL',
      message: 'x',
      status: 500,
    });
    renderPage();
    expect(await screen.findByText('Could not load this round.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: SWEEP_TITLE })).toBeTruthy();
    expect(api.listRounds).toHaveBeenCalledTimes(2);
  });

  it('changing the round keeps an existing ?agent=', async () => {
    wire();
    renderPage('/lab?agent=xiaoman');
    await screen.findByRole('heading', { name: SWEEP_TITLE });
    fireEvent.change(screen.getByLabelText('Round'), { target: { value: MANUAL_ID } });
    expect(await screen.findByRole('heading', { name: MANUAL_TITLE })).toBeTruthy();
    const search = new URLSearchParams(screen.getByTestId('search').textContent ?? '');
    expect(search.get('agent')).toBe('xiaoman');
    expect(search.get('round')).toBe(MANUAL_ID);
  });
});

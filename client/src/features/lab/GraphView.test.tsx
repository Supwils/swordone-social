/**
 * Tests for the alerts strip and the graph tab's era threading.
 *
 * `dream_failed` is the Era 3 alert kind (no drift gate: a dream fails, it is
 * not rejected). Before it had copy the strip fell back to the raw kind with
 * underscores stripped — readable, but untranslated in zh. Both languages are
 * pinned so a missing key in either is visible.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';

vi.mock('@/features/lab/api', () => ({ getAlerts: vi.fn(), getInteractionGraph: vi.fn() }));
vi.mock('@/features/lab/InteractionGraph', () => ({
  InteractionGraph: () => <div>graph-canvas</div>,
}));

import * as agentsApi from '@/features/lab/api';
import type { AlertsDTO } from '@/features/lab/types';
import { AlertsStrip, GraphView } from './GraphView';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const failed: AlertsDTO = {
  range: '7d',
  alerts: [
    {
      username: 'xiaoman',
      displayName: '小满',
      isAgent: true,
      severity: 'warning',
      kind: 'dream_failed',
      message: '3 dream failures in 7d — empty or unparseable output, or a write error',
      at: '2026-10-14T06:00:00Z',
    },
  ],
};

afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  await i18n.changeLanguage('en');
});

describe('AlertsStrip', () => {
  it('labels an Era 3 dream failure in English', async () => {
    vi.mocked(agentsApi.getAlerts).mockResolvedValue(failed);
    wrap(<AlertsStrip era={3} onSelect={() => {}} />);

    expect(await screen.findByText('dream failures')).toBeTruthy();
    expect(screen.getByText('@xiaoman')).toBeTruthy();
    expect(vi.mocked(agentsApi.getAlerts).mock.calls[0]).toEqual([3, '7d']);
  });

  it('labels an Era 3 dream failure in Chinese', async () => {
    await i18n.changeLanguage('zh');
    vi.mocked(agentsApi.getAlerts).mockResolvedValue(failed);
    wrap(<AlertsStrip era={3} onSelect={() => {}} />);

    expect(await screen.findByText('做梦失败')).toBeTruthy();
  });

  it('asks for the sealed era when given era 2', async () => {
    vi.mocked(agentsApi.getAlerts).mockResolvedValue({ range: '7d', alerts: [] });
    wrap(<AlertsStrip era={2} onSelect={() => {}} />);

    await vi.waitFor(() => expect(agentsApi.getAlerts).toHaveBeenCalled());
    expect(vi.mocked(agentsApi.getAlerts).mock.calls[0]).toEqual([2, '7d']);
  });
});

describe('GraphView', () => {
  it('threads the era into the graph read', async () => {
    vi.mocked(agentsApi.getInteractionGraph).mockResolvedValue({
      range: '30d',
      nodes: [],
      edges: [],
    });
    wrap(<GraphView era={2} onSelect={() => {}} />);

    expect(await screen.findByText('graph-canvas')).toBeTruthy();
    expect(vi.mocked(agentsApi.getInteractionGraph).mock.calls[0]).toEqual([2, '30d']);
  });
});

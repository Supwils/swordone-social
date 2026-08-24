import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';

vi.mock('@/api/agents', () => ({
  getBenchmarkLeaderboard: vi.fn(),
  getBenchmarkMatrix: vi.fn(),
  getBenchmarkCompare: vi.fn(),
}));

import * as agentsApi from '@/api/agents';
import type { BenchmarkCompare, BenchmarkLeaderboard, BenchmarkMatrix } from '@/api/types';
import { BenchmarkView } from './BenchmarkView';

/** Fixture values are all mutually distinguishable after formatting:
 *  fidelity 0.812 (3dp), judge 87.4 -> 87, rule 0.75 -> 75%, consistency
 *  0.91 (2dp), latency 2300ms -> 2.3s, runs 5. The second row is all-null to
 *  pin the em-dash path. */
function makeLeaderboard(over: Partial<BenchmarkLeaderboard> = {}): BenchmarkLeaderboard {
  return {
    totalRuns: 12,
    rows: [
      {
        model: 'opus',
        runs: 5,
        fidelity: 0.812,
        judge: 87.4,
        rule: 0.75,
        consistency: 0.91,
        latencyMs: 2300,
      },
      {
        model: 'codex',
        runs: 7,
        fidelity: null,
        judge: null,
        rule: null,
        consistency: null,
        latencyMs: null,
      },
    ],
    personas: [{ persona: 'liushang', display: '流觞' }],
    tasks: [{ taskId: 'free_post', kind: 'gen' }],
    ...over,
  };
}

function makeMatrix(): BenchmarkMatrix {
  return {
    models: ['opus', 'codex'],
    personas: [{ persona: 'liushang', display: '流觞' }],
    cells: [{ persona: 'liushang', model: 'opus', fidelity: 0.74, judge: null, n: 3 }],
  };
}

function makeCompare(): BenchmarkCompare {
  return {
    persona: 'liushang',
    task: 'free_post',
    items: [
      {
        model: 'opus',
        runIndex: 0,
        output: 'the same prompt, answered in character',
        vectorFidelity: 0.8,
        judgeScore: 88.2,
        ruleScore: 0.5,
        ruleDetail: '',
      },
    ],
  };
}

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BenchmarkView />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(agentsApi.getBenchmarkLeaderboard).mockResolvedValue(makeLeaderboard());
  vi.mocked(agentsApi.getBenchmarkMatrix).mockResolvedValue(makeMatrix());
  vi.mocked(agentsApi.getBenchmarkCompare).mockResolvedValue(makeCompare());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('BenchmarkView', () => {
  it('shows the run-the-sweep empty state when no runs exist', async () => {
    // Hooks run before the early return, so the empty fixture must also
    // empty personas/tasks or the compare query fires anyway.
    vi.mocked(agentsApi.getBenchmarkLeaderboard).mockResolvedValue(
      makeLeaderboard({ totalRuns: 0, rows: [], personas: [], tasks: [] }),
    );

    renderView();

    expect(await screen.findByText('No benchmark runs yet.')).toBeTruthy();
    expect(screen.getByText('bash agent/scripts/benchmark-all.sh')).toBeTruthy();
    expect(agentsApi.getBenchmarkCompare).not.toHaveBeenCalled();
  });

  it('formats every leaderboard column, em-dashing the null row', async () => {
    renderView();

    // 'Opus' also heads the heatmap and compare columns — scope to the board.
    const lb = (await screen.findByText('Model leaderboard — who stays in character')).closest(
      'section',
    ) as HTMLElement;
    expect(within(lb).getByText('Opus')).toBeTruthy();
    expect(within(lb).getByText('0.812')).toBeTruthy(); // fidelity, 3dp
    expect(within(lb).getByText('87')).toBeTruthy(); // judge, rounded
    expect(within(lb).getByText('75%')).toBeTruthy(); // rule as percent
    expect(within(lb).getByText('0.91')).toBeTruthy(); // consistency, 2dp
    expect(within(lb).getByText('2.3s')).toBeTruthy(); // latency in seconds
    expect(within(lb).getByText('5')).toBeTruthy(); // runs

    expect(within(lb).getByText('Codex')).toBeTruthy();
    // The all-null row renders an em-dash per metric column (5 of them).
    expect(within(lb).getAllByText('—').length).toBeGreaterThanOrEqual(5);
  });

  it('renders the persona×model heatmap with n in the tooltip and · for gaps', async () => {
    renderView();

    const cell = await screen.findByTitle('@liushang × Opus: 0.740 (n=3)');
    expect(cell.textContent).toBe('0.74');
    // codex column has no cell for this persona.
    expect(screen.getByTitle('@liushang × Codex: — (n=0)').textContent).toBe('·');
  });

  it('loads the side-by-side comparison for the default persona and task', async () => {
    renderView();

    await waitFor(() =>
      expect(agentsApi.getBenchmarkCompare).toHaveBeenCalledWith('liushang', 'free_post'),
    );
    expect(await screen.findByText('the same prompt, answered in character')).toBeTruthy();
    expect(screen.getByText('fid 0.80')).toBeTruthy();
    expect(screen.getByText('rule 50%')).toBeTruthy();
    expect(screen.getByText('judge 88')).toBeTruthy();
  });
});

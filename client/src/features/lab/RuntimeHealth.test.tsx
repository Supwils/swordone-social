/**
 * Tests for the /lab RuntimeHealth strip (spec §13).
 *
 * FIXTURE RULE THIS SUITE OBEYS (standing constraint §4): every pinned
 * value must be distinguishable from every value the code could plausibly
 * have used instead.
 *
 *   - `range` is `7d` / `90d`, NEVER `30d` — the endpoint's own default
 *     and what every other lab query asks for, so a strip that dropped
 *     the argument or hardcoded it would pass a `30d` fixture.
 *   - `rounds` is 17, `failOpenGates` is 3, `missingSamples` is 0,
 *     `landedActions` is 41, `accountsRun` is 11 — none of them 0 / 23 /
 *     30, and all different from each other so a card that printed
 *     another card's number is visible.
 *   - the two sparkline days fall on 2026-08-14 and 2026-08-20, and their
 *     per-day counts sum to the totals above, so a strip that showed a
 *     day's number as the window total would still fail the unique totals.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';

vi.mock('@/features/lab/api', () => ({ getRuntimeHealth: vi.fn() }));
vi.mock('./Sparkline', () => ({ Sparkline: () => null }));

import * as agentsApi from '@/features/lab/api';
import type { RuntimeHealthDTO } from '@/features/lab/types';
import { RuntimeHealth } from './RuntimeHealth';

function mk(o: Partial<RuntimeHealthDTO> = {}): RuntimeHealthDTO {
  return {
    range: '7d',
    rounds: 17,
    accountsRun: 11,
    failOpenGates: 3,
    missingSamples: 0,
    landedActions: 41,
    missingPostVectors: 0,
    points: [
      {
        date: '2026-08-14',
        rounds: 4,
        failOpen: 1,
        missingSamples: 0,
        landed: 9,
        missingPostVectors: 0,
      },
      {
        date: '2026-08-20',
        rounds: 13,
        failOpen: 2,
        missingSamples: 0,
        landed: 32,
        missingPostVectors: 0,
      },
    ],
    ...o,
  };
}

// Era 2 by default: the fail-open tile these suites pin exists only there.
function renderStrip(
  range: '7d' | '30d' | '90d' = '7d',
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  era: 2 | 3 = 2,
) {
  return render(
    <QueryClientProvider client={client}>
      <RuntimeHealth era={era} range={range} />
    </QueryClientProvider>,
  );
}

function card(label: string): HTMLElement {
  const el = screen.getByText(label).closest('[data-signal]');
  if (!el) throw new Error(`no [data-signal] ancestor for "${label}"`);
  return el as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RuntimeHealth — the four numbers come off the wire', () => {
  it('renders rounds / fail-open / missing / landed from the mocked payload', async () => {
    vi.mocked(agentsApi.getRuntimeHealth).mockResolvedValue(mk());
    renderStrip('7d');

    expect(await screen.findByText('Rounds')).toBeTruthy();
    expect(card('Rounds').textContent).toContain('17');
    expect(card('Fail-open gates').textContent).toContain('3');
    expect(card('Missing samples').textContent).toContain('0');
    expect(card('Landed actions').textContent).toContain('41');
  });

  it('threads the range it was given, rather than defaulting it', async () => {
    vi.mocked(agentsApi.getRuntimeHealth).mockResolvedValue(mk());

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderStrip('7d', client);
    await screen.findByText('Rounds');
    expect(vi.mocked(agentsApi.getRuntimeHealth).mock.calls[0]).toEqual([2, '7d']);

    cleanup();
    renderStrip('90d', client);
    await screen.findAllByText('Rounds');
    expect(vi.mocked(agentsApi.getRuntimeHealth).mock.calls).toHaveLength(2);
    expect(vi.mocked(agentsApi.getRuntimeHealth).mock.calls[1]).toEqual([2, '90d']);
  });
});

describe('RuntimeHealth — status tint', () => {
  it('applies warn tint when failOpenGates > 0', async () => {
    vi.mocked(agentsApi.getRuntimeHealth).mockResolvedValue(mk());
    renderStrip('7d');

    expect(await screen.findByText('Runtime needs watching')).toBeTruthy();
    expect(card('Fail-open gates').getAttribute('data-status')).toBe('warn');
  });

  it('applies warn tint when missingSamples > 0 even if fail-open is zero', async () => {
    vi.mocked(agentsApi.getRuntimeHealth).mockResolvedValue(
      mk({ failOpenGates: 0, missingSamples: 5, landedActions: 41 }),
    );
    renderStrip('7d');

    expect(await screen.findByText('Runtime needs watching')).toBeTruthy();
    expect(card('Missing samples').getAttribute('data-status')).toBe('warn');
    expect(card('Fail-open gates').getAttribute('data-status')).toBe('good');
  });

  it('is healthy when rounds ran and nothing failed open or went missing', async () => {
    vi.mocked(agentsApi.getRuntimeHealth).mockResolvedValue(
      mk({ failOpenGates: 0, missingSamples: 0 }),
    );
    renderStrip('7d');

    expect(await screen.findByText('Runtime healthy')).toBeTruthy();
    expect(card('Fail-open gates').getAttribute('data-status')).toBe('good');
    expect(card('Missing samples').getAttribute('data-status')).toBe('good');
  });

  it('stays neutral when there are no rounds', async () => {
    vi.mocked(agentsApi.getRuntimeHealth).mockResolvedValue(
      mk({
        rounds: 0,
        accountsRun: 0,
        failOpenGates: 0,
        missingSamples: 0,
        landedActions: 0,
        points: [
          {
            date: '2026-08-14',
            rounds: 0,
            failOpen: 0,
            missingSamples: 0,
            landed: 0,
            missingPostVectors: 0,
          },
          {
            date: '2026-08-20',
            rounds: 0,
            failOpen: 0,
            missingSamples: 0,
            landed: 0,
            missingPostVectors: 0,
          },
        ],
      }),
    );
    renderStrip('7d');

    expect(await screen.findByText('No runtime rounds')).toBeTruthy();
    expect(card('Rounds').getAttribute('data-status')).toBe('neutral');
    expect(card('Fail-open gates').getAttribute('data-status')).toBe('neutral');
    expect(card('Missing samples').getAttribute('data-status')).toBe('neutral');
  });

  it('does not look idle when the fetch fails with no data', async () => {
    vi.mocked(agentsApi.getRuntimeHealth).mockRejectedValue(new Error('ECONNREFUSED'));
    renderStrip('7d');

    expect(await screen.findByText('Runtime health unavailable right now.')).toBeTruthy();
    expect(screen.queryByText('No runtime rounds')).toBeNull();
    expect(screen.queryByText('Rounds')).toBeNull();
    const strip = screen
      .getByText('Runtime health unavailable right now.')
      .closest('[data-runtime-status]');
    expect(strip?.getAttribute('data-runtime-status')).toBe('warn');
  });
});

/**
 * Era 3 has no drift gate, so a "fail-open gates" tile would be a permanent 0
 * that reads as good news. It is replaced by the act path's own gap: posts that
 * landed without a post vector (7 — distinct from every other fixture number).
 */
describe('RuntimeHealth — Era 3 tiles', () => {
  it('drops the fail-open tile and shows post vectors missing', async () => {
    vi.mocked(agentsApi.getRuntimeHealth).mockResolvedValue(
      mk({ failOpenGates: 0, missingPostVectors: 7 }),
    );
    renderStrip('90d', undefined, 3);

    expect(await screen.findByText('Rounds')).toBeTruthy();
    expect(screen.queryByText('Fail-open gates')).toBeNull();
    expect(card('Post vectors missing').textContent).toContain('7');
    expect(card('Post vectors missing').getAttribute('data-status')).toBe('warn');
    expect(screen.getByText('Runtime needs watching')).toBeTruthy();
    expect(vi.mocked(agentsApi.getRuntimeHealth).mock.calls[0]).toEqual([3, '90d']);
  });

  it('is healthy in Era 3 when no post vector is missing', async () => {
    vi.mocked(agentsApi.getRuntimeHealth).mockResolvedValue(
      mk({ failOpenGates: 0, missingPostVectors: 0 }),
    );
    renderStrip('7d', undefined, 3);

    expect(await screen.findByText('Runtime healthy')).toBeTruthy();
    expect(card('Post vectors missing').getAttribute('data-status')).toBe('good');
    expect(card('Landed actions').textContent).toContain('41');
  });

  it('keeps Era 2 free of the post-vector tile', async () => {
    vi.mocked(agentsApi.getRuntimeHealth).mockResolvedValue(mk({ missingPostVectors: 7 }));
    renderStrip('7d', undefined, 2);

    expect(await screen.findByText('Fail-open gates')).toBeTruthy();
    expect(screen.queryByText('Post vectors missing')).toBeNull();
  });

  it('keys the cache on era, so one era never serves the other', async () => {
    vi.mocked(agentsApi.getRuntimeHealth).mockResolvedValue(mk());
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderStrip('7d', client, 2);
    await screen.findByText('Rounds');
    cleanup();
    renderStrip('7d', client, 3);
    await screen.findByText('Rounds');
    expect(vi.mocked(agentsApi.getRuntimeHealth).mock.calls).toEqual([
      [2, '7d'],
      [3, '7d'],
    ]);
  });
});

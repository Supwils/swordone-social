/**
 * Tests for `CollapsePanel`.
 *
 * FIXTURE RULE THIS SUITE OBEYS (standing constraint §4): every pinned value
 * must be distinguishable from every value the code could plausibly have used
 * instead.
 *
 *   - `range` is `90d` / `7d`, never `30d` — the endpoint's own default and
 *     what the rest of `AgentDetail` asks for.
 *   - `minPoints` is 5, not the server's 4, so a client-side copy of the floor
 *     is caught.
 *   - `similarityAvailableFrom` is 2026-08-14, NOT the real 2026-08-19, for the
 *     same reason: the panel must echo the wire rather than know the constant.
 *   - the two series carry different `n`, `spanDays`, `r2` and slopes, so a row
 *     that rendered the other series' numbers is visible.
 *   - the window instants are fixed; nothing here reads the real clock.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';

vi.mock('@/features/lab/api', () => ({ getCollapseWatch: vi.fn() }));

import * as agentsApi from '@/features/lab/api';
import type { CollapseSeriesDTO, CollapseWatchDTO } from '@/features/lab/types';
import { CollapsePanel } from './CollapsePanel';

/**
 * `liushang`'s real numbers, 2026-07-22 → 2026-08-05: the one collapse this
 * detector can be validated against. `basis: 'length-only'` is the correct
 * answer for it — `maxSim` did not exist yet — and that is the point of the field.
 */
const LENGTH_FITTED: CollapseSeriesDTO = {
  key: 'length',
  unit: 'characters',
  n: 8,
  first: 41,
  firstAt: '2026-07-22T09:00:00.000Z',
  last: 22,
  lastAt: '2026-08-05T18:00:00.000Z',
  spanDays: 14.4,
  slopePerDay: -0.792009,
  slopeStdErr: 0.406654,
  r2: 0.387,
  trend: 'down',
  fit: 'fitted',
};

const SIM_PREDATES: CollapseSeriesDTO = {
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
};

const SIM_FITTED: CollapseSeriesDTO = {
  key: 'selfSimilarity',
  unit: 'cosine-similarity',
  n: 6,
  first: 0.412,
  firstAt: '2026-08-15T10:00:00.000Z',
  last: 0.887,
  lastAt: '2026-08-20T10:00:00.000Z',
  spanDays: 5.2,
  slopePerDay: 0.09135,
  slopeStdErr: 0.01204,
  r2: 0.834,
  trend: 'up',
  fit: 'fitted',
};

function mk(o: Partial<CollapseWatchDTO> = {}): CollapseWatchDTO {
  return {
    username: 'liushang',
    since: '2026-07-22T00:00:00.000Z',
    until: '2026-08-05T00:00:00.000Z',
    minPoints: 5,
    // Not the real 2026-08-19: a panel that knew the constant instead of
    // echoing the wire would print the wrong date here.
    similarityAvailableFrom: '2026-08-14T00:00:00.000Z',
    basis: 'length-only',
    verdict: 'shrinking',
    length: LENGTH_FITTED,
    selfSimilarity: SIM_PREDATES,
    ...o,
  };
}

/**
 * `client` is a parameter so the range-threading test can reuse ONE cache across
 * two renders. With a fresh `QueryClient` per render, a query key that dropped
 * `range` would still refetch and the test could not see the omission.
 */
function renderPanel(
  range: '7d' | '30d' | '90d' = '90d',
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return render(
    <QueryClientProvider client={client}>
      <CollapsePanel username="liushang" range={range} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CollapsePanel — wiring', () => {
  it('threads the range it was given, rather than defaulting it', async () => {
    vi.mocked(agentsApi.getCollapseWatch).mockResolvedValue(mk());

    // ONE cache across both renders: a query key without `range` would serve the
    // second render from the first render's entry and never make a second call.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    renderPanel('90d', client);
    await screen.findByText(/Posts are getting shorter\./);
    expect(vi.mocked(agentsApi.getCollapseWatch).mock.calls[0]).toEqual(['liushang', '90d']);

    cleanup();
    renderPanel('7d', client);
    await screen.findAllByText(/Posts are getting shorter\./);
    expect(vi.mocked(agentsApi.getCollapseWatch).mock.calls).toHaveLength(2);
    expect(vi.mocked(agentsApi.getCollapseWatch).mock.calls[1]).toEqual(['liushang', '7d']);
  });

  it('states on its face that it enforces nothing', async () => {
    vi.mocked(agentsApi.getCollapseWatch).mockResolvedValue(mk());
    renderPanel();
    expect(await screen.findByText(/It measures; it enforces nothing/)).toBeTruthy();
  });

  it('echoes the window and the availability date the server sent', async () => {
    vi.mocked(agentsApi.getCollapseWatch).mockResolvedValue(mk());
    renderPanel();
    expect(
      await screen.findByText(
        /Window 2026-07-22 → 2026-08-05 · self-similarity can only exist from 2026-08-14/,
      ),
    ).toBeTruthy();
  });

  it('says why there is no significance test rather than silently omitting one', async () => {
    vi.mocked(agentsApi.getCollapseWatch).mockResolvedValue(mk());
    renderPanel();
    expect(await screen.findByText(/does not clear a 95% test at n=8/)).toBeTruthy();
  });
});

describe('CollapsePanel — the liushang case (basis: length-only)', () => {
  it('reports shrinking on one leg and says the second leg is missing', async () => {
    vi.mocked(agentsApi.getCollapseWatch).mockResolvedValue(mk());
    renderPanel();

    expect(await screen.findByText('Posts are getting shorter.')).toBeTruthy();
    expect(
      screen.getByText(/Length only — the self-similarity half has nothing to say/),
    ).toBeTruthy();
    expect(screen.getByText(/there is no second opinion on the verdict/)).toBeTruthy();
    // A one-legged answer must never present as the two-legged one.
    expect(screen.queryByText(/two independent signs agreeing/)).toBeNull();
    expect(screen.queryByText(/Both signals were available/)).toBeNull();
  });

  it('renders the length trend with the numbers that make it believable', async () => {
    vi.mocked(agentsApi.getCollapseWatch).mockResolvedValue(mk());
    renderPanel();

    expect(
      await screen.findByText(
        /41 → 22 characters over 14\.4 days · falling -0\.792 chars\/day \(± 0\.407\) · r² 0\.387 · n 8/,
      ),
    ).toBeTruthy();
  });

  it('blames the instrument, not the account, for the missing similarity leg', async () => {
    vi.mocked(agentsApi.getCollapseWatch).mockResolvedValue(mk());
    renderPanel();

    expect(
      await screen.findByText(/the act path only began sampling self-similarity on 2026-08-14/),
    ).toBeTruthy();
    expect(
      screen.getByText(/Normal for any historical window — not a gap in this account/),
    ).toBeTruthy();
    // `predates-instrument` is NOT `insufficient-points`.
    expect(screen.queryByText(/self-similarity samples here/)).toBeNull();
  });
});

describe('CollapsePanel — the other verdicts', () => {
  it('reports collapsing only when both legs agree, and says so', async () => {
    vi.mocked(agentsApi.getCollapseWatch).mockResolvedValue(
      mk({ basis: 'both', verdict: 'collapsing', selfSimilarity: SIM_FITTED }),
    );
    renderPanel();

    expect(
      await screen.findByText(
        /Posts are getting shorter AND more self-similar — two independent signs agreeing/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/Both signals were available in this window and both were fitted/),
    ).toBeTruthy();
    expect(screen.queryByText('Posts are getting shorter.')).toBeNull();
    // The similarity row carries its OWN numbers, not the length row's.
    expect(
      screen.getByText(
        /0\.412 → 0\.887 over 5\.2 days · rising 0\.09135\/day \(± 0\.01204\) · r² 0\.834 · n 6/,
      ),
    ).toBeTruthy();
  });

  it('reports steady when length is not falling', async () => {
    vi.mocked(agentsApi.getCollapseWatch).mockResolvedValue(
      mk({
        verdict: 'steady',
        basis: 'both',
        length: { ...LENGTH_FITTED, slopePerDay: 0.331, trend: 'up' },
        selfSimilarity: SIM_FITTED,
      }),
    );
    renderPanel();

    expect(await screen.findByText('Post length is not falling in this window.')).toBeTruthy();
    expect(screen.queryByText('Posts are getting shorter.')).toBeNull();
  });

  it('names n and the server’s own minimum when there is not enough to judge', async () => {
    vi.mocked(agentsApi.getCollapseWatch).mockResolvedValue(
      mk({
        verdict: 'insufficient-data',
        basis: 'none',
        length: {
          ...LENGTH_FITTED,
          n: 3,
          spanDays: 1.5,
          slopePerDay: null,
          slopeStdErr: null,
          r2: null,
          trend: null,
          fit: 'insufficient-points',
        },
      }),
    );
    renderPanel();

    // 3 of 5 — the 5 comes off the wire, not from a client constant.
    expect(
      await screen.findByText(
        /Only 3 posts with text in this window; a length trend needs at least 5/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/No basis — the length half could not be fitted/)).toBeTruthy();
    expect(screen.getByText(/Only 3 posts with text here — a trend needs at least 5/)).toBeTruthy();
  });

  /**
   * `basis: 'none'` — and therefore `verdict: 'insufficient-data'` — is set for
   * ANY unfitted length half, so this state and the one above share a verdict
   * and do NOT share a reason. `n` is 9 against a `minPoints` of 5 so the two
   * branches are distinguishable in both directions: the count sentence would
   * here read "Only 9 posts … needs at least 5", which is not merely
   * self-refuting (as it is at n = 5) but flatly false.
   */
  it('names the timestamps, not the count, when the length half is vertical', async () => {
    vi.mocked(agentsApi.getCollapseWatch).mockResolvedValue(
      mk({
        verdict: 'insufficient-data',
        basis: 'none',
        length: {
          ...LENGTH_FITTED,
          n: 9,
          spanDays: 0,
          slopePerDay: null,
          slopeStdErr: null,
          r2: null,
          trend: null,
          fit: 'no-time-span',
        },
      }),
    );
    renderPanel();

    expect(
      await screen.findByText(
        /All 9 posts with text in this window share one timestamp — a length trend needs points at different times, not more of them\./,
      ),
    ).toBeTruthy();
    // The count-shaped refusal belongs to `insufficient-points` alone.
    expect(screen.queryByText(/a length trend needs at least 5/)).toBeNull();
  });
});

describe('CollapsePanel — the similarity half degrades in named ways', () => {
  it('distinguishes "too few samples" from "the sampler did not exist"', async () => {
    vi.mocked(agentsApi.getCollapseWatch).mockResolvedValue(
      mk({
        selfSimilarity: { ...SIM_FITTED, n: 2, fit: 'insufficient-points' },
      }),
    );
    renderPanel();

    expect(
      await screen.findByText(
        /Only 2 self-similarity samples here — only rounds that actually post record one — and a trend needs at least 5/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/only began sampling self-similarity/)).toBeNull();
  });

  it('reports a vertical similarity fit as no time span', async () => {
    vi.mocked(agentsApi.getCollapseWatch).mockResolvedValue(
      mk({
        selfSimilarity: { ...SIM_FITTED, n: 7, spanDays: 0, fit: 'no-time-span' },
      }),
    );
    renderPanel();

    expect(await screen.findByText(/All 7 samples share one timestamp/)).toBeTruthy();
    expect(screen.queryByText(/Only 7 self-similarity samples here/)).toBeNull();
  });

  it('reports a vertical length fit as no time span, in the length half’s own words', async () => {
    vi.mocked(agentsApi.getCollapseWatch).mockResolvedValue(
      mk({
        verdict: 'insufficient-data',
        basis: 'none',
        length: { ...LENGTH_FITTED, n: 5, spanDays: 0, fit: 'no-time-span' },
      }),
    );
    renderPanel();

    expect(await screen.findByText(/All 5 posts share one timestamp/)).toBeTruthy();
    expect(screen.queryByText(/All 5 samples share one timestamp/)).toBeNull();
    // The verdict headline above this row used to read "Only 5 posts with text
    // in this window; a length trend needs at least 5" — five is not fewer than
    // five, and the refusal was never about the count.
    expect(screen.queryByText(/Only 5 posts with text in this window/)).toBeNull();
    expect(
      screen.getByText(/All 5 posts with text in this window share one timestamp/),
    ).toBeTruthy();
  });

  it('labels which direction is bad for each unit', async () => {
    vi.mocked(agentsApi.getCollapseWatch).mockResolvedValue(mk());
    renderPanel();

    expect(
      await screen.findByText(/post length · characters, a fall = shorter posts/),
    ).toBeTruthy();
    expect(screen.getByText(/self-similarity · cosine sim, a rise = more repetitive/)).toBeTruthy();
  });
});

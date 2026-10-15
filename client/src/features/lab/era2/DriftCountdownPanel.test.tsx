/**
 * Tests for `DriftCountdownPanel`.
 *
 * FIXTURE RULE THIS SUITE OBEYS (standing constraint §4, found eleven times on
 * this codebase): every pinned value must be distinguishable from every value
 * the code could plausibly have used instead.
 *
 *   - `range` is `90d` / `7d`, NEVER `30d` — which is both the endpoint's own
 *     default and what every other query in `AgentDetail` asks for, so a panel
 *     that dropped the argument or hardcoded it would pass a `30d` fixture.
 *   - `roundIntervalHours` is 36 and `maxExtrapolation` is 4 — not the server's
 *     48 and 3, so a client-side copy of either constant is caught.
 *   - the four thresholds are 0.44 / 0.55 / 0.66 / 0.61 — none of them the real
 *     0.82 / 0.63 / 0.72 / 0.71, so the deleted `ASPECT_THRESHOLDS` cannot come
 *     back unnoticed, and all four differ from each other so a cross-series
 *     mix-up is visible.
 *   - `asOf` is a fixed instant and nothing here reads the real clock: a
 *     fixture that agrees with `new Date()` cannot disagree with code that
 *     calls it.
 *   - the four `latestAt` instants fall on FOUR different days (08-16 / 08-17 /
 *     08-13 / 08-11), none of them `asOf`'s day and none of them `crossesAt`'s.
 *     They used to be 08-18 / 08-19 / 08-19 / 08-19, and `day()` truncates, so
 *     three of the four rendered identically and a row printing another series'
 *     date — or `asOf` in place of a measurement — could not be seen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';

vi.mock('@/features/lab/api', () => ({ getDriftCountdown: vi.fn() }));

import * as agentsApi from '@/features/lab/api';
import type {
  DriftCountdownDTO,
  DriftCountdownKey,
  DriftCountdownSeriesDTO,
} from '@/features/lab/types';
import {
  DriftCountdownPanel,
  aspectThresholdsFrom,
  countdownHeadline,
} from './DriftCountdownPanel';

const AS_OF = '2026-08-20T11:22:33.000Z';

/** Per-series baselines, every field deliberately distinct across the four. */
const BASE: Record<DriftCountdownKey, DriftCountdownSeriesDTO> = {
  anchor: {
    key: 'anchor',
    n: 7,
    latestSim: 0.658,
    latestAt: '2026-08-16T01:02:03.000Z',
    thresholdSim: 0.44,
    thresholdBasis: 'event',
    spanDays: 3.75,
    simSlopePerDay: 0.00111,
    r2: 0.6,
    crossesAt: null,
    roundsRemaining: null,
    crossedAlready: false,
    projection: 'not-declining',
  },
  values: {
    key: 'values',
    n: 4,
    latestSim: 0.812,
    latestAt: '2026-08-17T02:03:04.000Z',
    thresholdSim: 0.55,
    thresholdBasis: 'event',
    spanDays: 12.5,
    simSlopePerDay: -0.00321,
    r2: 0.913,
    crossesAt: null,
    roundsRemaining: null,
    crossedAlready: false,
    projection: 'span-too-short',
  },
  style: {
    key: 'style',
    n: 5,
    latestSim: 0.734,
    latestAt: '2026-08-13T03:04:05.000Z',
    thresholdSim: 0.66,
    thresholdBasis: 'event',
    spanDays: 9.25,
    simSlopePerDay: -0.00412,
    r2: 0.842,
    // Already locked out: the crossing is BEHIND us, which is exactly why the
    // date is null and the round count is 0.
    crossesAt: null,
    roundsRemaining: 0,
    crossedAlready: true,
    projection: 'fitted',
  },
  topic: {
    key: 'topic',
    n: 6,
    latestSim: 0.691,
    latestAt: '2026-08-11T04:05:06.000Z',
    thresholdSim: 0.61,
    thresholdBasis: 'event',
    spanDays: 6.5,
    simSlopePerDay: -0.00513,
    r2: 0.771,
    crossesAt: '2026-09-04T00:00:00.000Z',
    roundsRemaining: 7,
    crossedAlready: false,
    projection: 'fitted',
  },
};

const over = (
  base: DriftCountdownSeriesDTO,
  o: Partial<DriftCountdownSeriesDTO>,
): DriftCountdownSeriesDTO => ({ ...base, ...o });

function mk(o: Partial<DriftCountdownDTO> = {}): DriftCountdownDTO {
  return {
    username: 'liushang',
    range: '90d',
    asOf: AS_OF,
    roundIntervalHours: 36,
    maxExtrapolation: 4,
    driftMode: 'aspect',
    gating: ['values', 'style', 'topic'],
    binding: 'style',
    series: [BASE.anchor, BASE.values, BASE.style, BASE.topic],
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
      <DriftCountdownPanel username="liushang" range={range} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DriftCountdownPanel — wiring', () => {
  it('threads the range it was given, rather than defaulting it', async () => {
    vi.mocked(agentsApi.getDriftCountdown).mockResolvedValue(mk());
    // ONE cache across both renders: a query key without `range` would serve the
    // second render from the first render's entry and never make a second call.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    renderPanel('90d', client);
    await screen.findByText(/Already past the style threshold/);
    expect(vi.mocked(agentsApi.getDriftCountdown).mock.calls[0]).toEqual(['liushang', '90d']);

    cleanup();
    renderPanel('7d', client);
    await screen.findAllByText(/Already past the style threshold/);
    expect(vi.mocked(agentsApi.getDriftCountdown).mock.calls).toHaveLength(2);
    expect(vi.mocked(agentsApi.getDriftCountdown).mock.calls[1]).toEqual(['liushang', '7d']);
  });

  it('echoes the cadence and the extrapolation bound the server sent', async () => {
    vi.mocked(agentsApi.getDriftCountdown).mockResolvedValue(mk());
    renderPanel();
    // 36h and 4x, not the server constants 48 and 3.
    expect(await screen.findByText(/1 round = 36h .* at most 4× the span/)).toBeTruthy();
    expect(screen.getByText(/as of 2026-08-20/)).toBeTruthy();
  });

  it('states on its face that it enforces nothing', async () => {
    vi.mocked(agentsApi.getDriftCountdown).mockResolvedValue(mk());
    renderPanel();
    expect(await screen.findByText(/It projects; it enforces nothing/)).toBeTruthy();
  });
});

describe('DriftCountdownPanel — crossedAlready is not "nothing to report"', () => {
  it('leads with ALREADY LOCKED OUT, and never with a "no lockout" sentence', async () => {
    vi.mocked(agentsApi.getDriftCountdown).mockResolvedValue(mk({ binding: 'style' }));
    renderPanel();

    // Names the aspect and the threshold it is already under.
    expect(await screen.findByText(/Already past the style threshold \(0\.660\)/)).toBeTruthy();
    expect(screen.getByText(/the lockout is CURRENT, not upcoming/)).toBeTruthy();
    // The two sentences that would say the opposite must be absent.
    expect(screen.queryByText(/No lockout date from the series/)).toBeNull();
    expect(screen.queryByText(/Locks out on .* in about/)).toBeNull();
  });

  it('renders the crossed series row as "already below", not as a missing date', async () => {
    vi.mocked(agentsApi.getDriftCountdown).mockResolvedValue(mk());
    renderPanel();
    expect(await screen.findByText(/Already below 0\.660 — 0 rounds remaining/)).toBeTruthy();
    // A date branch would have printed an em-dash placeholder for `crossesAt`.
    expect(screen.queryByText(/Crosses 0\.660 on —/)).toBeNull();
  });

  /**
   * THE FIXTURE IS THE STALE SUB-CASE, not a tidy one. `style` is crossed
   * (`crossedAlready: true`) while its `latestSim` of 0.734 sits ABOVE its
   * 0.660 threshold — which is not a contradiction but the shape the server's
   * countdown (`server/src/modules/agents/persona/countdown.ts`) describes: the
   * crossing landed after the last measurement, so the flag rests on the fit alone. Without a date on screen
   * the row reads as two numbers that disagree for no stated reason.
   */
  it('dates the reading, so a latest sim ABOVE the threshold reads as staleness', async () => {
    vi.mocked(agentsApi.getDriftCountdown).mockResolvedValue(mk());
    renderPanel();

    // The tension itself, with its date attached: 0.734 above 0.660, measured
    // 08-13 — this series' own date, not `asOf` (08-20) and not another row's.
    expect(
      await screen.findByText(
        /^style · gates · n 5 · span 9\.3d · latest sim 0\.734 \(measured 2026-08-13\) · threshold 0\.660$/,
      ),
    ).toBeTruthy();
    // And the sentence says what the disagreement MEANS.
    expect(screen.getByText(/it was fitted on readings ending 2026-08-13/)).toBeTruthy();
    expect(
      screen.getByText(
        /the crossing landed after that last measurement, so the two disagree because the fit is that stale — not because one of them is wrong/,
      ),
    ).toBeTruthy();
  });

  it('leaves the crossed sentence datable when the window held no reading', async () => {
    vi.mocked(agentsApi.getDriftCountdown).mockResolvedValue(
      mk({
        series: [
          BASE.anchor,
          BASE.values,
          over(BASE.style, { latestSim: null, latestAt: null }),
          BASE.topic,
        ],
      }),
    );
    renderPanel();
    // The em-dash placeholder, not a crash and not a borrowed date.
    expect(await screen.findByText(/it was fitted on readings ending —/)).toBeTruthy();
    expect(
      screen.getByText(
        /^style · gates · n 5 · span 9\.3d · latest sim — \(measured —\) · threshold 0\.660$/,
      ),
    ).toBeTruthy();
  });
});

describe('DriftCountdownPanel — a projected crossing', () => {
  it('shows the date, the round count and r² beside it', async () => {
    vi.mocked(agentsApi.getDriftCountdown).mockResolvedValue(mk({ binding: 'topic' }));
    renderPanel();

    expect(
      await screen.findByText(
        /Locks out on topic in about 7 rounds — around 2026-09-04 \(fit r² 0\.771\)/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/the lockout is CURRENT/)).toBeNull();
  });

  it('names the per-series crossing with its own r², not another series’', async () => {
    vi.mocked(agentsApi.getDriftCountdown).mockResolvedValue(mk({ binding: null }));
    renderPanel();
    expect(
      await screen.findByText(/Crosses 0\.610 on 2026-09-04 — 7 rounds away \(r² 0\.771\)/),
    ).toBeTruthy();
  });
});

describe('DriftCountdownPanel — every refusal is its own sentence', () => {
  it('says what it is WAITING for when no gating series has enough points', async () => {
    vi.mocked(agentsApi.getDriftCountdown).mockResolvedValue(
      mk({
        binding: null,
        series: [
          over(BASE.anchor, { n: 2, projection: 'insufficient-points', crossesAt: null }),
          over(BASE.values, { n: 3, projection: 'insufficient-points' }),
          // `no-time-span` is ALSO "not watched yet", not a fitted answer: a
          // vertical fit is an absence of history, the same as too few points.
          over(BASE.style, {
            n: 8,
            spanDays: 0,
            projection: 'no-time-span',
            crossedAlready: false,
          }),
          over(BASE.topic, { n: 2, projection: 'insufficient-points', crossesAt: null }),
        ],
      }),
    );
    renderPanel();

    expect(await screen.findByText(/Waiting for rounds\./)).toBeTruthy();
    expect(screen.getByText(/not a sign that nothing is moving/)).toBeTruthy();
    expect(screen.getByText(/Only 3 measurements here — too few to fit a line/)).toBeTruthy();
    expect(screen.getByText(/All 8 measurements share one timestamp/)).toBeTruthy();
    // "waiting" and "no lockout projected" are different facts.
    expect(screen.queryByText(/No lockout date from the series/)).toBeNull();
    expect(screen.queryByText(/Not declining/)).toBeNull();
  });

  /**
   * MIXED ON PURPOSE (standing constraint §4, and the twelfth instance on this
   * codebase was precisely this branch): one gating series is short of points
   * while the other two hold plenty of measurements that all share one instant.
   * A headline claiming "not enough measurements" is FALSE for two of the three,
   * and a fixture whose gating series are all in one state cannot see that.
   */
  it('does not blame the count in the waiting headline — a vertical fit is not a count problem', async () => {
    vi.mocked(agentsApi.getDriftCountdown).mockResolvedValue(
      mk({
        binding: null,
        series: [
          BASE.anchor, // non-gating, and fitted: it must not decide the headline
          over(BASE.values, { n: 2, projection: 'insufficient-points' }),
          over(BASE.style, {
            n: 11,
            spanDays: 0,
            projection: 'no-time-span',
            crossedAlready: false,
          }),
          over(BASE.topic, { n: 14, spanDays: 0, projection: 'no-time-span', crossesAt: null }),
        ],
      }),
    );
    renderPanel();

    expect(
      await screen.findByText(
        /No series the gate decides with can be fitted yet — too few measurements, or too few distinct timestamps; each row below says which/,
      ),
    ).toBeTruthy();
    // The sentence this replaces named a count for all three.
    expect(screen.queryByText(/has enough measurements to fit a line yet/)).toBeNull();
    // And the rows do say which, per series.
    expect(screen.getByText(/Only 2 measurements here — too few to fit a line/)).toBeTruthy();
    expect(screen.getByText(/All 11 measurements share one timestamp/)).toBeTruthy();
    expect(screen.getByText(/All 14 measurements share one timestamp/)).toBeTruthy();
  });

  it('distinguishes not-declining, span-too-short and no-threshold', async () => {
    vi.mocked(agentsApi.getDriftCountdown).mockResolvedValue(
      mk({
        binding: null,
        series: [
          BASE.anchor, // not-declining
          BASE.values, // span-too-short
          over(BASE.style, {
            projection: 'no-threshold',
            crossedAlready: false,
            roundsRemaining: null,
            thresholdSim: null,
            thresholdBasis: 'absent',
          }),
          over(BASE.topic, { projection: 'not-declining', simSlopePerDay: 0.002, crossesAt: null }),
        ],
      }),
    );
    renderPanel();

    // Not heading for the gate at all.
    expect(
      await screen.findByText(/Not declining \(0\.00111 sim\/day\)\. No lockout projected\./),
    ).toBeTruthy();
    // Heading for the gate, not watched long enough — the OPPOSITE fact, and it
    // names the span and the bound so the refusal can be checked.
    expect(
      screen.getByText(/Declining \(-0\.00321 sim\/day\), but watched for only 12\.5 days/),
    ).toBeTruthy();
    expect(screen.getByText(/further out than 4× that span/)).toBeTruthy();
    expect(screen.getByText(/Declining and under-watched, not flat/)).toBeTruthy();
    // Declining, but the measurements predate thresholds being recorded.
    expect(
      screen.getByText(/predate thresholds being recorded, so there is nothing to project/),
    ).toBeTruthy();
    expect(screen.getByText(/threshold not recorded/)).toBeTruthy();
  });

  it('reports a vertical fit as no time span, not as too few points', async () => {
    vi.mocked(agentsApi.getDriftCountdown).mockResolvedValue(
      mk({
        binding: null,
        series: [
          BASE.anchor,
          over(BASE.values, { n: 9, spanDays: 0, projection: 'no-time-span' }),
          over(BASE.style, { projection: 'not-declining', crossedAlready: false }),
          over(BASE.topic, { projection: 'not-declining', crossesAt: null }),
        ],
      }),
    );
    renderPanel();

    expect(await screen.findByText(/All 9 measurements share one timestamp/)).toBeTruthy();
    expect(screen.queryByText(/Only 9 measurements here/)).toBeNull();
  });

  it('says "not measured yet" — not "no signal" — when the window holds nothing', async () => {
    const empty = (key: DriftCountdownKey): DriftCountdownSeriesDTO => ({
      key,
      n: 0,
      latestSim: null,
      latestAt: null,
      thresholdSim: null,
      thresholdBasis: 'absent',
      spanDays: null,
      simSlopePerDay: null,
      r2: null,
      crossesAt: null,
      roundsRemaining: null,
      crossedAlready: false,
      projection: 'insufficient-points',
    });
    vi.mocked(agentsApi.getDriftCountdown).mockResolvedValue(
      mk({
        binding: null,
        driftMode: null,
        gating: [],
        series: [empty('anchor'), empty('values'), empty('style'), empty('topic')],
      }),
    );
    renderPanel();

    expect(await screen.findByText(/No drift measurements in this window at all/)).toBeTruthy();
    expect(screen.getByText(/Each round files one when it reaches the gate/)).toBeTruthy();
    // The mode-unknown sentence is a different claim and must not be the one shown.
    expect(screen.queryByText(/did not record which mode the gate was in/)).toBeNull();
    expect(screen.getAllByText(/Not measured in this window\./).length).toBe(4);
  });

  it('says the gate mode is unknown when there ARE measurements but no mode', async () => {
    vi.mocked(agentsApi.getDriftCountdown).mockResolvedValue(
      mk({ binding: null, driftMode: null, gating: [] }),
    );
    renderPanel();

    expect(await screen.findByText(/did not record which mode the gate was in/)).toBeTruthy();
    expect(screen.queryByText(/No drift measurements in this window at all/)).toBeNull();
  });

  it('says "no lockout date" only when a gating series was actually fitted', async () => {
    vi.mocked(agentsApi.getDriftCountdown).mockResolvedValue(
      mk({
        binding: null,
        series: [
          BASE.anchor,
          // MIXED on purpose: one gating series is still short of a fit while
          // two were fitted and produced no crossing. "Some series unfitted" is
          // not "waiting" — a fitted series that says "not declining" is an
          // answer, and the headline must report the answer, not the wait.
          over(BASE.values, { n: 2, projection: 'insufficient-points' }),
          over(BASE.style, { projection: 'not-declining', crossedAlready: false }),
          over(BASE.topic, {
            projection: 'span-too-short',
            crossesAt: null,
            roundsRemaining: null,
          }),
        ],
      }),
    );
    renderPanel();

    expect(
      await screen.findByText(/No lockout date from the series the gate decides with/),
    ).toBeTruthy();
    expect(screen.queryByText(/Waiting for rounds\./)).toBeNull();
  });
});

describe('DriftCountdownPanel — thresholds come off the wire', () => {
  it('shows each series’ own recorded threshold, not a constant', async () => {
    vi.mocked(agentsApi.getDriftCountdown).mockResolvedValue(mk());
    renderPanel();

    // None of these four is the real 0.82 / 0.63 / 0.72 / 0.71, so a hardcoded
    // copy anywhere in the client shows up here.
    expect(await screen.findByText(/whole document .* threshold 0\.440/)).toBeTruthy();
    expect(screen.getByText(/^values · gates · n 4 .* threshold 0\.550/)).toBeTruthy();
    expect(screen.getByText(/^style · gates · n 5 .* threshold 0\.660/)).toBeTruthy();
    expect(screen.getByText(/^topic · gates · n 6 .* threshold 0\.610/)).toBeTruthy();
  });

  it('marks the whole-document series diagnostic under aspect mode', async () => {
    vi.mocked(agentsApi.getDriftCountdown).mockResolvedValue(mk());
    renderPanel();
    expect(await screen.findByText(/^whole document · diagnostic only/)).toBeTruthy();
  });

  it('shows n, span and the latest sim — with the date it was measured — beside every projection', async () => {
    vi.mocked(agentsApi.getDriftCountdown).mockResolvedValue(mk());
    renderPanel();
    // Anchored at both ends: the date is part of the line, not an addition
    // somewhere else on the page, and it is THIS series' date (08-17), not the
    // page's `asOf` (08-20) nor any other row's.
    expect(
      await screen.findByText(
        /^values · gates · n 4 · span 12\.5d · latest sim 0\.812 \(measured 2026-08-17\) · threshold 0\.550$/,
      ),
    ).toBeTruthy();
  });
});

describe('aspectThresholdsFrom', () => {
  it('reads the three aspect thresholds off the wire', () => {
    expect(aspectThresholdsFrom(mk())).toEqual({ values: 0.55, style: 0.66, topic: 0.61 });
  });

  it('returns null for an aspect whose newest measurement carried none', () => {
    const data = mk({
      series: [
        BASE.anchor,
        over(BASE.values, { thresholdSim: null, thresholdBasis: 'absent' }),
        BASE.style,
        BASE.topic,
      ],
    });
    expect(aspectThresholdsFrom(data).values).toBeNull();
    expect(aspectThresholdsFrom(data).style).toBe(0.66);
  });

  it('returns nulls while the query has not resolved', () => {
    expect(aspectThresholdsFrom(undefined)).toEqual({ values: null, style: null, topic: null });
  });
});

describe('countdownHeadline', () => {
  it('picks the binding series by crossedAlready, not by the presence of a date', () => {
    const head = countdownHeadline(mk({ binding: 'style' }));
    expect(head.kind).toBe('crossed');
    expect(head.kind === 'crossed' && head.series.key).toBe('style');
  });

  it('reports a future crossing as projected', () => {
    expect(countdownHeadline(mk({ binding: 'topic' })).kind).toBe('projected');
  });
});

/**
 * `DriftCountdownPanel` — how many rounds until the drift gate locks an account
 * out, read off `GET /agents/:u/drift-countdown`.
 *
 * IT PROJECTS AND ENFORCES NOTHING, and the panel says so on its face. No value
 * rendered here reaches the gate, changes a threshold, or alters what any agent
 * does.
 *
 * WHY EVERY REFUSAL GETS ITS OWN SENTENCE. The endpoint deliberately declines to
 * answer in five named ways rather than returning a number it cannot support,
 * and collapsing them into one empty state would destroy the distinction it
 * paid for:
 *
 *   - `insufficient-points` is "not measured yet", NOT "no signal". `gate_step`
 *     only began filing these events on 2026-08-19, so this is the expected
 *     answer for every account until roughly a week of rounds accumulates. An
 *     empty axis here would read as "nothing is moving", which is the opposite
 *     of what is known.
 *   - `not-declining` is "this account is not heading for the gate".
 *   - `span-too-short` is "it IS heading for the gate and it has not been
 *     watched long enough to say when" — the opposite fact, same missing date.
 *   - `no-threshold` is "the measurements predate thresholds being recorded",
 *     a fact about the instrument rather than about the account.
 *   - `crossedAlready` is ALREADY LOCKED OUT. `crossesAt` is null on that
 *     branch because the crossing is behind us, so a panel that keyed on the
 *     date alone would render "no lockout projected" — the opposite of the
 *     truth, for exactly the accounts this feature exists to find.
 *
 * THRESHOLDS COME OFF THE WIRE, never from a constant here. They travel beside
 * each measurement (`thScalar`/`thValues`/`thStyle`/`thTopic`, shipped
 * 2026-08-20) precisely so a client copy cannot silently reinterpret history
 * when `agent/.env` is retuned. `AgentDetail` used to hold a third copy —
 * `ASPECT_THRESHOLDS`, whose comment said to keep it in sync with the Era 1 Bash
 * dream script (retired; the drift gate itself was removed in Era 3,
 * 2026-10-14) — and it is deleted in favour of
 * `aspectThresholdsFrom` below.
 */
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Skeleton } from '@/components/primitives';
import { getDriftCountdown } from '@/features/lab/api';
import type { DriftCountdownDTO, DriftCountdownKey, DriftCountdownSeries } from '@/features/lab/types';
import s from '@/features/lab/lab.module.css';

/** One query for the whole detail view: `AgentDetail` reuses this key for the chart's thresholds. */
export function useDriftCountdown(username: string, range: '7d' | '30d' | '90d') {
  return useQuery({
    queryKey: ['agent-countdown', username, range],
    queryFn: () => getDriftCountdown(username, range),
    staleTime: 60_000,
  });
}

/**
 * The per-aspect reject thresholds actually in force, for the aspect chart's
 * reference lines. Null for an aspect whose newest measurement carried none —
 * the line is then not drawn at all, rather than drawn at a guess.
 */
export function aspectThresholdsFrom(data: DriftCountdownDTO | undefined): {
  values: number | null;
  style: number | null;
  topic: number | null;
} {
  const pick = (key: DriftCountdownKey) =>
    data?.series.find((x) => x.key === key)?.thresholdSim ?? null;
  return { values: pick('values'), style: pick('style'), topic: pick('topic') };
}

/**
 * What the panel leads with. Kept as a value rather than as branches inside the
 * JSX so the "already locked out" case cannot quietly fall through to the same
 * output as "no lockout projected".
 */
export type CountdownHeadline =
  | { kind: 'no-measurements' }
  | { kind: 'mode-unknown' }
  | { kind: 'crossed'; series: DriftCountdownSeries }
  | { kind: 'projected'; series: DriftCountdownSeries }
  | { kind: 'waiting' }
  | { kind: 'none' };

export function countdownHeadline(data: DriftCountdownDTO): CountdownHeadline {
  const bound = data.binding ? data.series.find((x) => x.key === data.binding) : undefined;
  // Read `crossedAlready` and NOT `crossesAt`: a crossed series carries a null
  // date, so keying on the date would render the two opposite facts alike.
  if (bound) return { kind: bound.crossedAlready ? 'crossed' : 'projected', series: bound };
  if (data.series.every((x) => x.n === 0)) return { kind: 'no-measurements' };
  if (data.driftMode === null) return { kind: 'mode-unknown' };
  // No binding series, and every series the gate decides with is still short of
  // a fit: this is "not watched yet", not "nothing is moving".
  const gating = data.series.filter((x) => data.gating.includes(x.key));
  const unfitted = (x: DriftCountdownSeries) =>
    x.projection === 'insufficient-points' || x.projection === 'no-time-span';
  if (gating.length > 0 && gating.every(unfitted)) return { kind: 'waiting' };
  return { kind: 'none' };
}

function fmt(value: number | null, digits: number): string {
  return value === null ? '—' : value.toFixed(digits);
}

/** ISO instant → `YYYY-MM-DD`, the convention every other lab panel uses. */
function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—';
}

export function DriftCountdownPanel({
  username,
  range,
}: {
  username: string;
  range: '7d' | '30d' | '90d';
}) {
  const { t } = useTranslation();
  const q = useDriftCountdown(username, range);

  return (
    <section className={s.chartBlock}>
      <div className={s.chartTitle}>
        {t('lab.countdown.title')}
        {q.data?.driftMode && (
          <span className={s.modeBadge}>{t(`lab.countdown.mode.${q.data.driftMode}`)}</span>
        )}
      </div>
      <p className={s.blockSub}>{t('lab.countdown.sub')}</p>
      {q.isLoading ? (
        <Skeleton height={120} width="100%" />
      ) : q.isError || !q.data ? (
        <div className={s.emptyState}>{t('lab.countdown.error')}</div>
      ) : (
        <CountdownBody data={q.data} />
      )}
    </section>
  );
}

function CountdownBody({ data }: { data: DriftCountdownDTO }) {
  const { t } = useTranslation();
  const head = countdownHeadline(data);
  const tone =
    head.kind === 'crossed' ? s.conc_bad : head.kind === 'projected' ? s.conc_warn : s.conc_neutral;

  return (
    <>
      <div className={`${s.conclusion} ${tone}`}>
        <span className={s.concTag}>{t(`lab.countdown.headTag.${head.kind}`)}</span>
        <span className={s.concTitle}>
          {head.kind === 'crossed'
            ? t('lab.countdown.head.crossed', {
                aspect: t(`lab.countdown.key.${head.series.key}`),
                threshold: fmt(head.series.thresholdSim, 3),
              })
            : head.kind === 'projected'
              ? t('lab.countdown.head.projected', {
                  aspect: t(`lab.countdown.key.${head.series.key}`),
                  rounds: head.series.roundsRemaining ?? 0,
                  date: day(head.series.crossesAt),
                  r2: fmt(head.series.r2, 3),
                })
              : t(`lab.countdown.head.${head.kind}`)}
        </span>
      </div>

      <div className={s.timeline}>
        {data.series.map((series) => (
          <CountdownRow
            key={series.key}
            series={series}
            gating={data.gating.includes(series.key)}
            maxExtrapolation={data.maxExtrapolation}
          />
        ))}
      </div>

      <p className={s.blockSub}>
        {t('lab.countdown.footer', {
          hours: data.roundIntervalHours,
          mult: data.maxExtrapolation,
          asOf: day(data.asOf),
        })}
      </p>
    </>
  );
}

function CountdownRow({
  series,
  gating,
  maxExtrapolation,
}: {
  series: DriftCountdownSeries;
  gating: boolean;
  maxExtrapolation: number;
}) {
  const { t } = useTranslation();
  return (
    <div className={s.diffRow}>
      <span className={s.diffMeta}>
        {t(`lab.countdown.key.${series.key}`)} ·{' '}
        {t(gating ? 'lab.countdown.gates' : 'lab.countdown.diagnostic')} ·{' '}
        {t('lab.countdown.meta', {
          n: series.n,
          span: fmt(series.spanDays, 1),
          latest: fmt(series.latestSim, 3),
          // WHY THE DATE TRAVELS WITH THE READING. `latestSim` alone cannot be
          // read against `thresholdSim`: on the `crossedAlready` branch the
          // crossing may sit AFTER the last measurement, in which case
          // `latestSim` is by construction still ABOVE the threshold while the
          // row says the lockout is current. The server's countdown
          // (`server/src/modules/agents/persona/countdown.ts`)
          // names this date as the mitigation for exactly that sub-case — the
          // cue that separates a stale fit from a contradiction — and until now
          // it was on the wire and on no screen.
          latestAt: day(series.latestAt),
          threshold:
            series.thresholdBasis === 'absent'
              ? t('lab.countdown.thresholdAbsent')
              : fmt(series.thresholdSim, 3),
        })}
      </span>
      <span className={s.timelineSummary}>{projectionSentence(series, maxExtrapolation, t)}</span>
    </div>
  );
}

/**
 * One sentence per refusal, and they must stay distinguishable from one
 * another — see the module header for what each one means.
 */
function projectionSentence(
  series: DriftCountdownSeries,
  maxExtrapolation: number,
  t: TFunction,
): string {
  switch (series.projection) {
    case 'fitted':
      // The crossed branch FIRST: a crossed series carries `crossesAt: null`,
      // so the date branch would print "—" and read as no lockout at all.
      return series.crossedAlready
        ? t('lab.countdown.proj.crossed', {
            threshold: fmt(series.thresholdSim, 3),
            // The honest limit of `crossedAlready`, rendered rather than left
            // in the service's comment: a crossing between the last
            // measurement and `asOf` rests on the fit alone, and this date is
            // how a reader sizes that gap.
            latestAt: day(series.latestAt),
          })
        : t('lab.countdown.proj.fitted', {
            threshold: fmt(series.thresholdSim, 3),
            date: day(series.crossesAt),
            rounds: series.roundsRemaining ?? 0,
            r2: fmt(series.r2, 3),
          });
    case 'insufficient-points':
      return series.n === 0
        ? t('lab.countdown.proj.noPoints')
        : t('lab.countdown.proj.insufficientPoints', { n: series.n });
    case 'no-time-span':
      return t('lab.countdown.proj.noTimeSpan', { n: series.n });
    case 'not-declining':
      return t('lab.countdown.proj.notDeclining', { slope: fmt(series.simSlopePerDay, 5) });
    case 'no-threshold':
      return t('lab.countdown.proj.noThreshold', { slope: fmt(series.simSlopePerDay, 5) });
    case 'span-too-short':
      return t('lab.countdown.proj.spanTooShort', {
        slope: fmt(series.simSlopePerDay, 5),
        span: fmt(series.spanDays, 1),
        mult: maxExtrapolation,
      });
  }
}

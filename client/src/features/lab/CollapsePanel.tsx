/**
 * `CollapsePanel` — is an account's OUTPUT rotting? Read off
 * `GET /agents/:u/collapse`.
 *
 * IT MEASURES AND ENFORCES NOTHING, and the panel says so on its face. There is
 * deliberately no act-path threshold anywhere behind this: the act path's
 * self-similarity stays in shadow (`agent/swil_agent/config.py:71-74`), and a
 * verdict of `collapsing` blocks nothing.
 *
 * WHY IT EXISTS. `liushang` spent five weeks contracting onto one recycled
 * phrase — posts falling from ~40 characters to ~22 — while the drift gate was
 * correctly rejecting its dreams the entire time. The gate screens the STATED
 * self (`personality.md`); nothing watched the REVEALED self, and a human
 * eventually noticed by reading posts. This is the instrument that should have.
 *
 * THE TWO HALVES ARE NOT SYMMETRIC, and the panel must never let them look it:
 *
 *   - POST LENGTH has history back to 2026-04. A FALL is shorter posts.
 *   - SELF-SIMILARITY (`maxSim`) begins 2026-08-19 and only POSTING rounds
 *     file one. A RISE is more repetitive output. For any historical window it
 *     is `predates-instrument` — which is a fact about the INSTRUMENT's age,
 *     not about the account, and reads nothing like `insufficient-points`.
 *
 * So `basis: 'length-only'` is the NORMAL answer for anything historical rather
 * than a degradation, and `collapsing` (both signs agreeing) is unreachable
 * without `basis: 'both'`. A one-legged answer is `shrinking` and says so.
 *
 * NO SIGNIFICANCE TEST, on evidence rather than by omission. `liushang`'s eight
 * posts give t = -1.948 against a two-sided 95% critical value of 2.447 at 6
 * degrees of freedom — the only collapse this detector can be validated against
 * does NOT clear a conventional test, so gating on one would ship an instrument
 * that cannot find the case it was built for. `slopeStdErr` is therefore
 * rendered beside every slope: a reader who wants that test has the ingredient.
 */
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Skeleton } from '@/components/primitives';
import { getCollapseWatch } from '@/features/lab/api';
import type { CollapseSeries, CollapseWatchDTO } from '@/features/lab/types';
import s from '@/features/lab/lab.module.css';

function fmt(value: number | null, digits: number): string {
  return value === null ? '—' : value.toFixed(digits);
}

/** ISO instant → `YYYY-MM-DD`, the convention every other lab panel uses. */
function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—';
}

const VERDICT_TONE: Record<CollapseWatchDTO['verdict'], string> = {
  collapsing: s.conc_bad,
  shrinking: s.conc_warn,
  steady: s.conc_good,
  'insufficient-data': s.conc_neutral,
};

export function CollapsePanel({
  username,
  range,
}: {
  username: string;
  range: '7d' | '30d' | '90d';
}) {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['agent-collapse', username, range],
    queryFn: () => getCollapseWatch(username, range),
    staleTime: 60_000,
  });

  return (
    <section className={s.chartBlock}>
      <div className={s.chartTitle}>{t('lab.collapse.title')}</div>
      <p className={s.blockSub}>{t('lab.collapse.sub')}</p>
      {q.isLoading ? (
        <Skeleton height={120} width="100%" />
      ) : q.isError || !q.data ? (
        <div className={s.emptyState}>{t('lab.collapse.error')}</div>
      ) : (
        <CollapseBody data={q.data} />
      )}
    </section>
  );
}

function CollapseBody({ data }: { data: CollapseWatchDTO }) {
  const { t } = useTranslation();
  return (
    <>
      <div className={`${s.conclusion} ${VERDICT_TONE[data.verdict]}`}>
        <span className={s.concTag}>{t(`lab.collapse.verdictTag.${data.verdict}`)}</span>
        <span className={s.concTitle}>{verdictSentence(data, t)}</span>
        {/*
          `basis` is what the verdict RESTS on, and it is rendered next to the
          verdict rather than tucked in a footnote: `shrinking` on one leg and
          `shrinking` on two legs that disagreed are different claims.
        */}
        <span className={s.concDetail}>{t(`lab.collapse.basis.${data.basis}`)}</span>
      </div>

      <div className={s.timeline}>
        <CollapseRow series={data.length} data={data} />
        <CollapseRow series={data.selfSimilarity} data={data} />
      </div>

      <p className={s.blockSub}>
        {t('lab.collapse.footer', {
          since: day(data.since),
          until: day(data.until),
          from: day(data.similarityAvailableFrom),
        })}
      </p>
    </>
  );
}

function CollapseRow({ series, data }: { series: CollapseSeries; data: CollapseWatchDTO }) {
  const { t } = useTranslation();
  return (
    <div className={s.diffRow}>
      <span className={s.diffMeta}>
        {t(`lab.collapse.series.${series.key}`)} · {t(`lab.collapse.unit.${series.unit}`)}
      </span>
      <span className={s.timelineSummary}>{fitSentence(series, data, t)}</span>
    </div>
  );
}

/**
 * The verdict sentence — and `insufficient-data` needs a branch of its own,
 * because ONE verdict stands for TWO different refusals.
 *
 * The server's collapse watch (`server/src/modules/agents/persona/collapse.ts`)
 * sets `basis: 'none'` whenever the length half is not `'fitted'`, and
 * `basis: 'none'` forces `verdict: 'insufficient-data'`. So a
 * window whose posts all share one timestamp arrives here alongside a window
 * that simply holds too few posts. Reading the count sentence over the first
 * one produced "Only 5 posts with text in this window; a length trend needs at
 * least 5" — a sentence that refutes itself and blames a count for a refusal
 * that was about timestamps. Five is not fewer than five.
 *
 * §7 CONDITION. `predates-instrument` falls through to the count branch, and
 * that is sound only because the length half can never carry it: the service
 * passes `preempted` for the self-similarity series alone (`persona/collapse.ts`
 * `seriesOf('length', …, null)`). Pass one for the length half and this needs
 * its own case, or the same wrong-reason bug returns under a new name.
 */
function verdictSentence(data: CollapseWatchDTO, t: TFunction): string {
  if (data.verdict !== 'insufficient-data') return t(`lab.collapse.verdict.${data.verdict}`);
  return data.length.fit === 'no-time-span'
    ? t('lab.collapse.verdict.insufficient-data-no-time-span', { n: data.length.n })
    : t('lab.collapse.verdict.insufficient-data', { n: data.length.n, min: data.minPoints });
}

/**
 * One sentence per fit outcome. `predates-instrument` is only ever set on the
 * self-similarity half (the service passes `preempted` for that series alone),
 * which is why its copy names the sampler.
 */
function fitSentence(series: CollapseSeries, data: CollapseWatchDTO, t: TFunction): string {
  const ns = series.key === 'length' ? 'len' : 'sim';
  switch (series.fit) {
    case 'fitted':
      return t(`lab.collapse.${ns}.fitted`, {
        first: fmt(series.first, 0),
        last: fmt(series.last, 0),
        firstSim: fmt(series.first, 3),
        lastSim: fmt(series.last, 3),
        span: fmt(series.spanDays, 1),
        slope: fmt(series.slopePerDay, series.key === 'length' ? 3 : 5),
        stderr: fmt(series.slopeStdErr, series.key === 'length' ? 3 : 5),
        r2: fmt(series.r2, 3),
        n: series.n,
        trend: t(`lab.collapse.trend.${series.trend ?? 'flat'}`),
      });
    case 'insufficient-points':
      return t(`lab.collapse.${ns}.insufficient`, { n: series.n, min: data.minPoints });
    case 'no-time-span':
      return t(`lab.collapse.${ns}.noTimeSpan`, { n: series.n });
    case 'predates-instrument':
      return t('lab.collapse.predates', {
        from: day(data.similarityAvailableFrom),
        until: day(data.until),
      });
  }
}

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { listLabAgents } from '@/features/lab/api';
import { useHomogenization, usePopulationPulse } from '@/features/lab/queries';
import { Skeleton } from '@/components/primitives';
import { Sparkline } from './Sparkline';
import { lastNonNull, mean, periodDelta } from './stats';
import type { LabEra } from '@/features/lab/types';
import s from '@/features/lab/lab.module.css';

type Status = 'good' | 'warn' | 'bad' | 'neutral';
type Range = '7d' | '30d' | '90d';

interface Signal {
  key: string;
  label: string;
  hint: string;
  value: string;
  status: Status;
  higherIsBetter: boolean | null; // null = informational (no good/bad direction)
  pct: number | null;
  spark: Array<{ v: number }>;
  sparkColor: string;
}

const STATUS_RANK: Record<Status, number> = { bad: 3, warn: 2, good: 1, neutral: 0 };

/**
 * Population Health — the golden-signal header (SRE-style "at-a-glance health →
 * drill-down"). Four vital signs of the agent ecosystem (Activity, Authenticity,
 * Diversity, Stability), each a standardized metric card: value + period delta +
 * real sparkline + status tint, all backed by the `/agents/pulse` timeseries and
 * the homogenization trend (no fabricated baselines). A composite verdict rolls
 * the three health-bearing signals up to one Healthy / Watch / Critical status.
 */
export function PopulationHealth({
  era,
  range,
  agents,
}: {
  era: LabEra;
  range: Range;
  agents: Awaited<ReturnType<typeof listLabAgents>>;
}) {
  const { t } = useTranslation();
  const pulseQ = usePopulationPulse(era, range);
  const homogQ = useHomogenization(era, range);

  const signals = useMemo<Signal[]>(() => {
    const pts = pulseQ.data?.points ?? [];
    const fidelities = agents
      .map((a) => a.currentFidelity)
      .filter((x): x is number => typeof x === 'number');
    const homogPts = homogQ.data?.points ?? [];
    const curCohesion = homogQ.data?.current.behaviorCohesion ?? null;

    // Activity — total actions in range, daily sparkline (informational).
    const actionSeries = pts.map((p) => p.actions);
    const totalActions = actionSeries.reduce((a, b) => a + b, 0);
    const actDelta = periodDelta(actionSeries);

    // Authenticity — current mean persona fidelity (lower = posts off-character).
    const meanFid = fidelities.length ? mean(fidelities) : null;
    const fidDelta = periodDelta(pts.map((p) => p.meanFidelity));
    const authStatus: Status =
      meanFid === null ? 'neutral' : meanFid >= 0.8 ? 'good' : meanFid >= 0.7 ? 'warn' : 'bad';

    // Diversity — 1 − behavior cohesion (lower = monoculture risk).
    const diversity = curCohesion === null ? null : 1 - curCohesion;
    const divSeries = homogPts.map((p) => 1 - p.behaviorCohesion);
    const divDelta = periodDelta(divSeries);
    const divStatus: Status =
      diversity === null
        ? 'neutral'
        : diversity >= 0.25
          ? 'good'
          : diversity >= 0.15
            ? 'warn'
            : 'bad';

    // Stability — recent mean drift velocity (higher = personalities churning).
    const driftVel = lastNonNull(pts.map((p) => p.meanDriftVelocity));
    const velDelta = periodDelta(pts.map((p) => p.meanDriftVelocity));
    const stabStatus: Status =
      driftVel === null ? 'neutral' : driftVel <= 0.05 ? 'good' : driftVel <= 0.1 ? 'warn' : 'bad';

    return [
      {
        key: 'activity',
        label: t('lab.health.activity'),
        hint: t('lab.health.activityHint'),
        value: String(totalActions),
        status: 'neutral',
        higherIsBetter: null,
        pct: actDelta.pct,
        spark: actionSeries.map((v) => ({ v })),
        sparkColor: 'var(--color-border-strong)',
      },
      {
        key: 'authenticity',
        label: t('lab.health.authenticity'),
        hint: t('lab.health.authenticityHint'),
        value: meanFid === null ? '—' : meanFid.toFixed(3),
        status: authStatus,
        higherIsBetter: true,
        pct: fidDelta.pct,
        spark: pts
          .filter((p) => p.meanFidelity !== null)
          .map((p) => ({ v: p.meanFidelity as number })),
        sparkColor: 'var(--color-success)',
      },
      {
        key: 'diversity',
        label: t('lab.health.diversity'),
        hint: t('lab.health.diversityHint'),
        value: diversity === null ? '—' : diversity.toFixed(3),
        status: divStatus,
        higherIsBetter: true,
        pct: divDelta.pct,
        spark: divSeries.map((v) => ({ v })),
        sparkColor: 'var(--color-accent)',
      },
      {
        key: 'stability',
        label: t('lab.health.stability'),
        hint: t('lab.health.stabilityHint'),
        value: driftVel === null ? '—' : driftVel.toFixed(3),
        status: stabStatus,
        higherIsBetter: false,
        pct: velDelta.pct,
        spark: pts
          .filter((p) => p.meanDriftVelocity !== null)
          .map((p) => ({ v: p.meanDriftVelocity as number })),
        sparkColor: 'var(--color-warning)',
      },
    ];
  }, [pulseQ.data, homogQ.data, agents, t]);

  // Composite verdict = worst of the three health-bearing signals.
  const composite = useMemo<Status>(() => {
    const health = signals.filter((sig) => sig.higherIsBetter !== null);
    return health.reduce<Status>(
      (worst, sig) => (STATUS_RANK[sig.status] > STATUS_RANK[worst] ? sig.status : worst),
      'good',
    );
  }, [signals]);

  if (pulseQ.isLoading) return <Skeleton height={150} width="100%" />;

  const verdictLabel =
    composite === 'bad'
      ? t('lab.health.critical')
      : composite === 'warn'
        ? t('lab.health.watch')
        : t('lab.health.healthy');

  return (
    <section className={s.health}>
      <div className={s.healthHead}>
        <span className={`${s.healthDot} ${s[`hdot_${composite}`] ?? ''}`} />
        <span className={s.healthVerdict}>{verdictLabel}</span>
        <span className={s.healthSub}>{t('lab.health.sub')}</span>
      </div>
      <div className={s.signalGrid}>
        {signals.map((sig) => (
          <div key={sig.key} className={`${s.signal} ${s[`sig_${sig.status}`] ?? ''}`}>
            <div className={s.signalTop}>
              <span className={s.signalLabel}>{sig.label}</span>
              <DeltaChip pct={sig.pct} higherIsBetter={sig.higherIsBetter} />
            </div>
            <span className={s.signalValue}>{sig.value}</span>
            <span className={s.signalHint}>{sig.hint}</span>
            <div className={s.signalSpark}>
              <Sparkline data={sig.spark} color={sig.sparkColor} strokeWidth={1.5} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function DeltaChip({
  pct,
  higherIsBetter,
}: {
  pct: number | null;
  higherIsBetter: boolean | null;
}) {
  if (pct === null || Math.abs(pct) < 0.05) {
    return <span className={`${s.delta} ${s.deltaFlat}`}>—</span>;
  }
  const up = pct > 0;
  // good/bad direction only when the signal has one
  let tone = s.deltaFlat;
  if (higherIsBetter !== null) {
    const good = higherIsBetter ? up : !up;
    tone = good ? s.deltaGood : s.deltaBad;
  }
  return (
    <span className={`${s.delta} ${tone}`}>
      {up ? '▲' : '▼'} {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

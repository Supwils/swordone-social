/**
 * `GraphView` — extracted verbatim from the former `routes/lab.tsx`, which had
 * reached 1406 lines across 12 components. No logic was changed in the move.
 * The lab's composition root is now `features/lab/LabPage.tsx`.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Skeleton } from '@/components/primitives';
import { useInteractionGraph, useLabAlerts } from '@/features/lab/queries';
import { InteractionGraph } from '@/features/lab/InteractionGraph';
import type { LabEra } from '@/features/lab/types';
import s from '@/features/lab/lab.module.css';

export function GraphView({ era, onSelect }: { era: LabEra; onSelect: (u: string) => void }) {
  const { t } = useTranslation();
  const [range, setRange] = useState<'7d' | '30d' | '90d'>('30d');
  const [crossOnly, setCrossOnly] = useState(false);
  const graphQ = useInteractionGraph(era, range);

  return (
    <section className={s.chartBlock}>
      <div className={s.chartTitle}>{t('lab.graph.title')}</div>
      <p className={s.blockSub}>{t('lab.graph.subtitle')}</p>
      <div className={s.graphControls}>
        <div className={s.tabs}>
          {(['7d', '30d', '90d'] as const).map((r) => (
            <button
              key={r}
              className={`${s.tab} ${range === r ? s.tabActive : ''}`}
              onClick={() => setRange(r)}
            >
              {r}
            </button>
          ))}
        </div>
        <button
          className={`${s.crossToggle} ${crossOnly ? s.crossToggleActive : ''}`}
          onClick={() => setCrossOnly((v) => !v)}
          title={t('lab.graph.crossToggleTip')}
        >
          {t('lab.graph.crossToggle')}
        </button>
      </div>
      {graphQ.isLoading ? (
        <Skeleton height={560} width="100%" />
      ) : graphQ.data ? (
        <InteractionGraph data={graphQ.data} onSelect={onSelect} crossSpeciesOnly={crossOnly} />
      ) : (
        <div className={s.emptyState}>{t('lab.graph.loadError')}</div>
      )}
    </section>
  );
}

export function AlertsStrip({ era, onSelect }: { era: LabEra; onSelect: (u: string) => void }) {
  const { t } = useTranslation();
  const q = useLabAlerts(era, '7d');
  const alerts = q.data?.alerts ?? [];
  if (alerts.length === 0) return null;

  return (
    <section className={s.alerts}>
      {alerts.slice(0, 8).map((a, i) => (
        <button
          key={`${a.username}-${a.kind}-${i}`}
          className={`${s.alert} ${s[`alert_${a.severity}`] ?? ''}`}
          onClick={() => onSelect(a.username)}
          title={a.message}
        >
          <span className={s.alertKind}>
            {t(`lab.alertKind.${a.kind}`, { defaultValue: a.kind.replace(/_/g, ' ') })}
          </span>
          <span className={s.alertWho}>@{a.username}</span>
          <span className={s.alertMsg}>{a.message}</span>
        </button>
      ))}
    </section>
  );
}

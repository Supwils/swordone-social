/**
 * `HomogenizationPanel` — extracted verbatim from the former `routes/lab.tsx`, which had
 * reached 1406 lines across 12 components. No logic was changed in the move.
 * The lab's composition root is now `features/lab/LabPage.tsx`.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card } from '@/components/primitives';
import { useHomogenization } from '@/features/lab/queries';
import type { LabEra } from '@/features/lab/types';
import s from '@/features/lab/lab.module.css';

export function HomogenizationPanel({ era, range }: { era: LabEra; range: '7d' | '30d' | '90d' }) {
  const { t } = useTranslation();
  const q = useHomogenization(era, range);
  const series = useMemo(
    () =>
      (q.data?.points ?? []).map((p) => ({
        x: p.capturedAt.slice(5, 10),
        persona: Number(p.personaCohesion.toFixed(4)),
        behavior: Number(p.behaviorCohesion.toFixed(4)),
      })),
    [q.data],
  );
  const cur = q.data?.current;
  const trend = series.length >= 2 ? series[series.length - 1].behavior - series[0].behavior : 0;
  const trendLabel =
    trend > 0.01 ? t('lab.homog.up') : trend < -0.01 ? t('lab.homog.down') : t('lab.homog.flat');

  return (
    <section className={s.chartBlock}>
      <div className={s.chartTitle}>{t('lab.homog.title')}</div>
      <p className={s.blockSub}>{t('lab.homog.sub')}</p>
      <section className={s.readoutGrid}>
        <Card className={s.tile}>
          <span className={s.tileLabel}>{t('lab.homog.persona')}</span>
          <span className={s.tileValue}>{cur ? cur.personaCohesion.toFixed(3) : '—'}</span>
          <span className={s.tileHint}>{t('lab.homog.personaHint', { count: cur?.n ?? 0 })}</span>
        </Card>
        <Card className={s.tile}>
          <span className={s.tileLabel}>{t('lab.homog.behavior')}</span>
          <span className={s.tileValue}>{cur ? cur.behaviorCohesion.toFixed(3) : '—'}</span>
          <span className={s.tileHint}>{cur ? trendLabel : t('lab.homog.waiting')}</span>
        </Card>
      </section>
      <div className={s.chartHeight}>
        {series.length < 2 ? (
          <div className={s.emptyState}>{t('lab.homog.empty')}</div>
        ) : (
          <ResponsiveContainer>
            <LineChart data={series} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="x" stroke="var(--color-text-muted)" fontSize={11} />
              <YAxis stroke="var(--color-text-muted)" fontSize={11} domain={[0, 1]} />
              <Tooltip
                contentStyle={{
                  background: 'var(--color-surface)',
                  border: '1px solid var(--color-border)',
                  fontSize: 12,
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line
                type="monotone"
                dataKey="behavior"
                name={t('lab.homog.legendBehavior')}
                stroke="var(--color-accent)"
                strokeWidth={2}
                dot={{ r: 3 }}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="persona"
                name={t('lab.homog.legendPersona')}
                stroke="var(--color-text-muted)"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}

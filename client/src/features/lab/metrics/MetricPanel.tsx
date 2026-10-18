/**
 * `MetricPanel` — one pre-registered Era 3 metric: per-arm line over the
 * window's sweep ordinals (plus the population line for convergence), the arm
 * table the decision rule reads, the verdict with its between/within spread,
 * and the descriptive companion lines.
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
import type { ArmId, ArmsReportDTO, MetricBlock } from '@/features/lab/types';
import labStyles from '@/features/lab/lab.module.css';
import { ARM_COLOR, ARM_IDS, ARM_LABEL } from './armColors';
import { buildChartRows, describeVerdict, fmtNum, metricFormat } from './format';
import { ArmName } from './ArmName';
import { VerdictText } from './VerdictText';
import s from './metrics.module.css';

export function MetricPanel({ block, report }: { block: MetricBlock; report: ArmsReportDTO }) {
  const { t } = useTranslation();
  const fmt = metricFormat(block.key);
  const rows = useMemo(() => buildChartRows(block), [block]);
  const hasData = rows.some((r) => r.population !== null || ARM_IDS.some((arm) => r[arm] !== null));
  const roundIdOf = new Map(rows.map((r) => [r.ordinal, r.roundId]));
  const armRow = new Map(block.arms.map((a) => [a.arm, a]));
  const verdict = block.verdict;
  const tone = describeVerdict(verdict).tone;
  // Repetition is a share in [0, 1]; the slope metrics' levels are similarities.
  const yTick = (v: number) =>
    block.key === 'repetition' ? `${Math.round(v * 100)}%` : v.toFixed(2);

  return (
    <section className={`${labStyles.chartBlock} ${s.panel}`}>
      <div className={labStyles.chartTitle}>{t(`lab.era3.metric.${block.key}.title`)}</div>
      <p className={labStyles.blockSub}>{t(`lab.era3.metric.${block.key}.sub`)}</p>

      <div className={s.panelBody}>
        <div>
          <div className={s.chart}>
            {!hasData ? (
              <div className={labStyles.emptyState}>{t('lab.era3.chart.empty')}</div>
            ) : (
              <ResponsiveContainer>
                <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 16, left: 0 }}>
                  <CartesianGrid
                    stroke="var(--color-border)"
                    strokeDasharray="3 3"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="ordinal"
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    allowDecimals={false}
                    stroke="var(--color-text-muted)"
                    fontSize={11}
                    label={{
                      value: t('lab.era3.chart.axis'),
                      position: 'insideBottom',
                      offset: -4,
                      fontSize: 11,
                      fill: 'var(--color-text-muted)',
                    }}
                  />
                  <YAxis
                    stroke="var(--color-text-muted)"
                    fontSize={11}
                    domain={['auto', 'auto']}
                    tickFormatter={yTick}
                    width={44}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--color-surface)',
                      border: '1px solid var(--color-border)',
                      fontSize: 12,
                    }}
                    labelFormatter={(label) =>
                      t('lab.era3.chart.round', {
                        ordinal: label,
                        roundId: roundIdOf.get(Number(label)) ?? '',
                      })
                    }
                    formatter={(v) => (typeof v === 'number' ? fmt(v) : String(v ?? ''))}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {/* No connectNulls: a round without an arm's data must read as a gap. */}
                  {ARM_IDS.map((arm) => (
                    <Line
                      key={arm}
                      type="monotone"
                      dataKey={arm}
                      name={ARM_LABEL[arm]}
                      stroke={ARM_COLOR[arm]}
                      strokeWidth={2}
                      dot={{ r: 3 }}
                      isAnimationActive={false}
                    />
                  ))}
                  {block.population && (
                    <Line
                      type="monotone"
                      dataKey="population"
                      name={t('lab.era3.chart.population')}
                      stroke="var(--color-text-muted)"
                      strokeWidth={1.5}
                      strokeDasharray="5 4"
                      dot={false}
                      isAnimationActive={false}
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
          <p className={s.note}>{t(`lab.era3.metric.${block.key}.chart`)}</p>
        </div>

        <div className={s.subBlock}>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th scope="col">{t('lab.era3.table.arm')}</th>
                  <th scope="col">{t('lab.era3.table.mean')}</th>
                  <th scope="col">{t('lab.era3.table.sd')}</th>
                  <th scope="col">{t('lab.era3.table.accounts')}</th>
                  <th scope="col">{t('lab.era3.table.qualifies')}</th>
                </tr>
              </thead>
              <tbody>
                {ARM_IDS.map((arm) => {
                  const a = armRow.get(arm);
                  return (
                    <tr key={arm}>
                      <td>
                        <ArmName arm={arm} />
                      </td>
                      <td>{fmt(a?.mean)}</td>
                      <td>{fmt(a?.sd)}</td>
                      <td>{a?.accounts ?? 0}</td>
                      <td className={a?.qualifies ? undefined : s.muted}>
                        {a?.qualifies ? t('lab.era3.table.yes') : t('lab.era3.table.no')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className={s.note}>{t(`lab.era3.metric.${block.key}.table`)}</p>

          <div className={`${s.verdictLine} ${s[`tone_${tone}`]}`}>
            <VerdictText
              verdict={verdict}
              done={report.completedRounds}
              target={report.targetRounds}
            />
            <span className={s.spread}>
              {t('lab.era3.verdict.spread', {
                between: fmt(verdict.between),
                within: fmt(verdict.within),
              })}
            </span>
          </div>
          <p className={s.note}>{t('lab.era3.verdict.rule')}</p>

          {block.companions.length > 0 && (
            <div>
              <div className={labStyles.chartTitle}>{t('lab.era3.companions.title')}</div>
              <ul className={s.companions}>
                {block.companions.map((c) => (
                  <li key={c.label}>
                    {companionLine(
                      t(`lab.era3.companions.${c.label}`, { defaultValue: c.label }),
                      c.arms,
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** "Level: OpenAI 0.701 · Grok 0.711 · …" — companions are similarities or slopes. */
function companionLine(label: string, arms: { arm: ArmId; value: number | null }[]): string {
  const byArm = new Map(arms.map((a) => [a.arm, a.value]));
  const parts = ARM_IDS.map((arm) => `${ARM_LABEL[arm]} ${fmtNum(byArm.get(arm) ?? null)}`);
  return `${label}: ${parts.join(' · ')}`;
}

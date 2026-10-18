/**
 * `ExperimentHeader` — top of the Era 3 dashboard: progress toward the 12
 * completed rounds, one status chip per arm (rounds with data against the
 * 9-round floor), and one verdict line per pre-registered metric.
 */
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/primitives';
import type { ArmsReportDTO } from '@/features/lab/types';
import { ARM_COLOR, ARM_IDS, ARM_LABEL } from './armColors';
import { describeVerdict, frozenAtOf, type Tone } from './format';
import { VerdictText } from './VerdictText';
import s from './metrics.module.css';

const METRIC_KEYS = ['fidelity', 'repetition', 'convergence'] as const;

export function ExperimentHeader({ report }: { report: ArmsReportDTO }) {
  const { t } = useTranslation();
  const frozenAt = frozenAtOf(report.metrics);
  const done = report.completedRounds;
  const target = report.targetRounds;
  const floor = report.minArmRounds;
  const modelOf = new Map(report.arms.map((a) => [a.id, a]));

  return (
    <Card className={s.header} as="section">
      <div className={s.headerTop}>
        <div>
          <h2 className={s.headerTitle}>{t('lab.era3.header.title')}</h2>
          <p className={s.headerSub}>{t('lab.era3.header.sub')}</p>
        </div>
        <div className={s.progress}>
          <span className={s.caption}>{t('lab.era3.header.rounds')}</span>
          <span className={s.progressValue}>{`${done}/${target}`}</span>
          <span className={s.progressHint}>
            {frozenAt
              ? t('lab.era3.header.frozen', { roundId: frozenAt })
              : t('lab.era3.header.provisional', { target })}
          </span>
        </div>
      </div>

      <div className={s.caption}>{t('lab.era3.header.arms')}</div>
      <div className={s.chips}>
        {ARM_IDS.map((arm) => {
          const rounds = report.armRounds[arm] ?? 0;
          const ok = rounds >= floor;
          const tone: Tone = ok ? 'good' : frozenAt ? 'warn' : 'neutral';
          const word = ok ? 'armOk' : frozenAt ? 'armIncomplete' : 'armCollecting';
          const info = modelOf.get(arm);
          return (
            <div
              key={arm}
              className={s.chip}
              style={{ borderLeftColor: ARM_COLOR[arm] }}
              data-testid={`arm-chip-${arm}`}
            >
              <div className={s.chipHead}>
                <span>{ARM_LABEL[arm]}</span>
                <span className={`${s.status} ${s[`status_${tone}`]}`}>
                  {t(`lab.era3.header.${word}`)}
                </span>
              </div>
              {info && <span className={s.chipModel}>{info.model}</span>}
              <span>{t('lab.era3.header.accounts', { n: info?.accounts.length ?? 0 })}</span>
              <span>{t('lab.era3.header.armRounds', { n: rounds, floor })}</span>
            </div>
          );
        })}
      </div>

      <div className={s.caption}>{t('lab.era3.header.verdicts')}</div>
      <ul className={s.verdictList}>
        {METRIC_KEYS.map((key) => {
          const verdict = report.metrics[key].verdict;
          return (
            <li
              key={key}
              className={`${s.verdictLine} ${s[`tone_${describeVerdict(verdict).tone}`]}`}
            >
              <span className={s.verdictName}>{t(`lab.era3.metric.${key}.title`)}</span>
              <VerdictText verdict={verdict} done={done} target={target} />
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

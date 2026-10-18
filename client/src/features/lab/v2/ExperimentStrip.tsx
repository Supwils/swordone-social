/** One line above the digest: completed rounds, the next round's ETA, the provisional rule. */
import { useTranslation } from 'react-i18next';
import type { ArmsReportDTO, RoundListItem } from '@/features/lab/types';
import s from './v2.module.css';

/** The round script's default `ROUND_MIN_INTERVAL_HOURS` (48), in ms. */
export const ROUND_INTERVAL_MS = 48 * 3_600_000;

const fmtUtc = (ms: number): string =>
  `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

export function ExperimentStrip({
  report,
  rounds,
  now,
}: {
  report: ArmsReportDTO;
  rounds: RoundListItem[];
  now: number;
}) {
  const { t } = useTranslation();
  const newestSweep = rounds.find((r) => r.kind === 'sweep');
  const eta = newestSweep ? Date.parse(newestSweep.startedAt) + ROUND_INTERVAL_MS : null;
  return (
    <p className={s.strip}>
      <span>
        {t('lab.v2.strip.rounds', { done: report.completedRounds, target: report.targetRounds })}
      </span>
      {eta !== null && (
        <span>
          {eta > now ? t('lab.v2.strip.next', { eta: fmtUtc(eta) }) : t('lab.v2.strip.nextDue')}
        </span>
      )}
      <span>
        {report.completedRounds >= report.targetRounds
          ? t('lab.v2.strip.frozen', { target: report.targetRounds })
          : t('lab.v2.strip.provisional', { target: report.targetRounds })}
      </span>
    </p>
  );
}

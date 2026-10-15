import { useTranslation } from 'react-i18next';
import type { Verdict } from '@/features/lab/types';
import { describeVerdict } from './format';
import s from './era3.module.css';

/**
 * One verdict's status words. Provisional (with k/12) until the window
 * freezes; "no difference" carries the decision rule's conservativeness note.
 */
export function VerdictText({
  verdict,
  done,
  target,
}: {
  verdict: Verdict;
  done: number;
  target: number;
}) {
  const { t } = useTranslation();
  const { kind } = describeVerdict(verdict);
  return (
    <span className={s.verdictText}>
      <span>{t(`lab.era3.verdict.${kind}`, { done, target })}</span>
      {kind === 'noDifference' && (
        <span className={s.hint}>{t('lab.era3.verdict.noDifferenceHint')}</span>
      )}
    </span>
  );
}

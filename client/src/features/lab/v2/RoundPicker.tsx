/** The round selector; an unknown `?round=` value is shown as itself rather than silently as another round. */
import { useTranslation } from 'react-i18next';
import type { RoundListItem } from '@/features/lab/types';
import s from './v2.module.css';

export function RoundPicker({
  rounds,
  value,
  onChange,
}: {
  rounds: RoundListItem[];
  value: string;
  onChange: (roundId: string) => void;
}) {
  const { t } = useTranslation();
  const known = rounds.some((r) => r.roundId === value);
  return (
    <div className={s.pickerRow}>
      {/* A sibling label, not a wrapping one: a wrapping label's accessible name would include every option. */}
      <label htmlFor="lab-v2-round">{t('lab.v2.picker.label')}</label>
      <select id="lab-v2-round" value={value} onChange={(e) => onChange(e.target.value)}>
        {!known && <option value={value}>{value}</option>}
        {rounds.map((r) => (
          <option key={r.roundId} value={r.roundId}>
            {`${r.roundId} · ${t(`lab.v2.picker.${r.kind}`)}${r.ordinal !== null ? ` #${r.ordinal}` : ''}${r.hasObservation ? ` · ${t('lab.v2.picker.noted')}` : ''}`}
          </option>
        ))}
      </select>
    </div>
  );
}

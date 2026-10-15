import { useTranslation } from 'react-i18next';
import type { LabEra } from '@/features/lab/types';
import s from '@/features/lab/lab.module.css';

const ERAS: readonly LabEra[] = [3, 2];

/** Segmented Era 3 / Era 2 control for the /lab header (S2 §9). */
export function EraSwitch({ era, onChange }: { era: LabEra; onChange: (e: LabEra) => void }) {
  const { t } = useTranslation();
  return (
    <div className={s.rangeControl} role="group" aria-label={t('lab.era.label')}>
      {ERAS.map((e) => (
        <button
          key={e}
          type="button"
          className={`${s.rangeBtn} ${era === e ? s.rangeBtnActive : ''}`}
          onClick={() => onChange(e)}
          aria-pressed={era === e}
        >
          {t(`lab.era.era${e}`)}
        </button>
      ))}
    </div>
  );
}

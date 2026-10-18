/**
 * The observer note (lab v2 §5): the only model-written text on the page,
 * labelled as such. Plain text only — React escapes it; it is never parsed as
 * HTML or Markdown.
 */
import { useTranslation } from 'react-i18next';
import type { RoundDigestDTO } from '@/features/lab/types';
import s from './v2.module.css';

export function ObserverNote({ observation }: { observation: RoundDigestDTO['observation'] }) {
  const { t } = useTranslation();
  if (!observation) return null;
  return (
    <aside className={s.observer}>
      <div className={s.observerLabel}>
        <span>{t('lab.v2.note.label', { model: observation.model })}</span>
        {observation.stale && <span className={s.badge}>{t('lab.v2.note.stale')}</span>}
      </div>
      <p className={s.preWrap}>{observation.text}</p>
    </aside>
  );
}

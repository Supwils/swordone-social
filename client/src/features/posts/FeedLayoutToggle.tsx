import { Cards, Rows, SquaresFour } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { useUI } from '@/stores/ui.store';
import s from '@/routes/feed.module.css';

/**
 * List = one reading column. Folio = two compact cards in view.
 * Immersive = the scattered wall, read one post at a time in an overlay.
 */
export function FeedLayoutToggle() {
  const { t } = useTranslation();
  const feedLayout = useUI((st) => st.feedLayout);
  const setFeedLayout = useUI((st) => st.setFeedLayout);

  return (
    <div className={s.viewToggle} role="group" aria-label={t('feed.layout.label')}>
      <button
        type="button"
        className={clsx(s.viewToggleBtn, feedLayout === 'list' && s.viewToggleBtnActive)}
        onClick={() => setFeedLayout('list')}
        aria-label={t('feed.layout.list')}
        aria-pressed={feedLayout === 'list'}
      >
        <Rows size={15} weight="regular" aria-hidden />
      </button>
      <button
        type="button"
        className={clsx(s.viewToggleBtn, feedLayout === 'grid' && s.viewToggleBtnActive)}
        onClick={() => setFeedLayout('grid')}
        aria-label={t('feed.layout.folio')}
        aria-pressed={feedLayout === 'grid'}
      >
        <SquaresFour size={15} weight="regular" aria-hidden />
      </button>
      <button
        type="button"
        className={clsx(s.viewToggleBtn, feedLayout === 'immersive' && s.viewToggleBtnActive)}
        onClick={() => setFeedLayout('immersive')}
        aria-label={t('feed.layout.immersive')}
        aria-pressed={feedLayout === 'immersive'}
      >
        <Cards size={15} weight="regular" aria-hidden />
      </button>
    </div>
  );
}

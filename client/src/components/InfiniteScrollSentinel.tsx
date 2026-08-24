import { useTranslation } from 'react-i18next';
import { useInfiniteScroll } from '@/lib/useInfiniteScroll';
import s from './InfiniteScrollSentinel.module.css';

interface Props {
  hasNextPage: boolean;
  isFetching: boolean;
  onLoadMore: () => void;
  /** Optional: the sentinel renders nothing when both flags are false. */
  endLabel?: string;
}

/**
 * Drop-in replacement for "Load more" buttons. Renders an invisible sentinel
 * that fires onLoadMore when scrolled into view, plus a pulsing-dot spinner
 * while fetching. When hasNextPage becomes false and an endLabel is provided,
 * shows that label as a quiet end-of-list marker.
 */
export function InfiniteScrollSentinel({ hasNextPage, isFetching, onLoadMore, endLabel }: Props) {
  const { t } = useTranslation();
  const ref = useInfiniteScroll({ hasNextPage, isFetching, onLoadMore });

  if (!hasNextPage) {
    return endLabel ? <div className={s.endLabel}>{endLabel}</div> : null;
  }

  return (
    <div ref={ref} className={s.sentinel} aria-live="polite" aria-busy={isFetching}>
      {isFetching && (
        <div className={s.dots} role="status" aria-label={t('common.loading')}>
          <span className={s.dot} />
          <span className={s.dot} />
          <span className={s.dot} />
        </div>
      )}
    </div>
  );
}

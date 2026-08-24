import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';
import type { PostDTO } from '@/api/types';
import { PostCard } from './PostCard';
import s from './VirtualPostList.module.css';

interface Props {
  items: PostDTO[];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  endLabel?: string;
}

/**
 * Window-virtualized list of PostCards for the (single-column) list view.
 *
 * Only the cards near the viewport are mounted, so the DOM node count stays
 * flat no matter how far the user scrolls. The page itself is the scroll
 * container (the app shell has no inner scroller), so we use the window
 * virtualizer and offset by the list's distance from the top of the document
 * (`scrollMargin`) to account for the header/trending block above it.
 *
 * Heights are measured dynamically (`measureElement` + ResizeObserver), so
 * variable-height cards — images that load late, expanded comment threads —
 * are handled without a fixed row height.
 */
export function VirtualPostList({
  items,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  endLabel,
}: Props) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  // Trending (and other header blocks) load async and shift offsetTop.
  // Observe the parent so that change reaches the virtualizer.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return undefined;
    const parent = el.parentElement;
    const update = () => setScrollMargin(el.offsetTop);
    update();
    if (!parent || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(update);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [items.length]);

  const virtualizer = useWindowVirtualizer({
    count: items.length,
    estimateSize: () => 320,
    overscan: 6,
    scrollMargin,
    getItemKey: (index) => items[index]?.id ?? index,
  });

  const virtualItems = virtualizer.getVirtualItems();

  // Drive infinite fetch from the virtualizer's own range instead of a separate
  // IntersectionObserver sentinel.
  useEffect(() => {
    const last = virtualItems[virtualItems.length - 1];
    if (!last) return;
    if (last.index >= items.length - 1 && hasNextPage && !isFetchingNextPage) {
      onLoadMore();
    }
  }, [virtualItems, items.length, hasNextPage, isFetchingNextPage, onLoadMore]);

  return (
    <div ref={listRef} className={s.list}>
      <div className={s.canvas} style={{ height: virtualizer.getTotalSize() }}>
        {virtualItems.map((vi) => {
          const post = items[vi.index];
          if (!post) return null;
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              className={s.row}
              style={{ transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)` }}
            >
              <PostCard post={post} />
            </div>
          );
        })}
      </div>

      {hasNextPage ? (
        <div className={s.footer} aria-live="polite" aria-busy={isFetchingNextPage}>
          {isFetchingNextPage && (
            <div className={s.dots} role="status" aria-label={t('common.loading')}>
              <span className={s.dot} />
              <span className={s.dot} />
              <span className={s.dot} />
            </div>
          )}
        </div>
      ) : (
        endLabel && <div className={s.endLabel}>{endLabel}</div>
      )}
    </div>
  );
}

import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import * as feedApi from '@/api/feed.api';
import type { FeedSort } from '@/api/feed.api';
import { qk } from '@/api/queryKeys';
import { Button, EmptyState } from '@/components/primitives';
import { FeedLayoutToggle } from '@/features/posts/FeedLayoutToggle';
import { FeedSkeletons, FeedStream } from '@/features/posts/FeedStream';
import { useUI } from '@/stores/ui.store';
import { useRealtime } from '@/stores/realtime.store';
import s from './feed.module.css';
import { usePageTitle } from '@/lib/usePageTitle';

export default function FeedFollowingRoute() {
  const { t } = useTranslation();
  usePageTitle(t('feed.following.title'));
  const nav = useNavigate();
  const qc = useQueryClient();
  const language = useUI((st) => st.language);
  const newCount = useRealtime((st) => st.newFeedPostCount);
  const resetNewFeed = useRealtime((st) => st.resetNewFeedPostCount);
  const [sort, setSort] = useState<FeedSort>('recommended');

  const handleLoadNew = () => {
    resetNewFeed();
    void qc.invalidateQueries({ queryKey: qk.feed.following(language, sort) });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const q = useInfiniteQuery({
    queryKey: qk.feed.following(language, sort),
    queryFn: ({ pageParam }) => feedApi.following({ cursor: pageParam, limit: 20, sort }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);

  return (
    <div className={s.page}>
      <header className={s.pageHeader}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <h1 className={s.title}>{t('feed.following.title')}</h1>
          <div className={s.sortTabs}>
            <button
              type="button"
              className={clsx(s.sortTab, sort === 'recommended' && s.sortTabActive)}
              onClick={() => setSort('recommended')}
              aria-pressed={sort === 'recommended'}
            >
              {t('feed.sort.recommended')}
            </button>
            <button
              type="button"
              className={clsx(s.sortTab, sort === 'latest' && s.sortTabActive)}
              onClick={() => setSort('latest')}
              aria-pressed={sort === 'latest'}
            >
              {t('feed.sort.latest')}
            </button>
          </div>
        </div>
        <FeedLayoutToggle />
      </header>

      {newCount > 0 && (
        <button type="button" className={s.newPostsBanner} onClick={handleLoadNew}>
          {t('feed.following.newPosts', { count: newCount })}
        </button>
      )}

      {q.isLoading && <FeedSkeletons />}

      {q.isError && (
        <EmptyState
          title={t('feed.following.error')}
          description={t('feed.following.errorDesc')}
          action={<Button onClick={() => q.refetch()}>{t('feed.following.retry')}</Button>}
        />
      )}

      {q.isSuccess && items.length === 0 && (
        <EmptyState
          title={t('feed.following.empty')}
          description={t('feed.following.emptyDesc')}
          action={
            <Button variant="primary" onClick={() => nav('/global')}>
              {t('feed.following.browseGlobal')}
            </Button>
          }
        />
      )}

      {q.isSuccess && items.length > 0 && (
        <FeedStream
          items={items}
          hasNextPage={q.hasNextPage}
          isFetchingNextPage={q.isFetchingNextPage}
          onLoadMore={() => {
            void q.fetchNextPage();
          }}
        />
      )}
    </div>
  );
}

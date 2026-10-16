import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import * as feedApi from '@/api/feed.api';
import type { FeedSort } from '@/api/feed.api';
import * as tagsApi from '@/api/tags.api';
import { qk } from '@/api/queryKeys';
import { Button, EmptyState, UITag } from '@/components/primitives';
import { FeedLayoutToggle } from '@/features/posts/FeedLayoutToggle';
import { FeedSkeletons, FeedStream } from '@/features/posts/FeedStream';
import { flattenPostPages } from '@/features/posts/postCache';
import { useUI } from '@/stores/ui.store';
import s from './feed.module.css';
import { usePageTitle } from '@/lib/usePageTitle';

export default function FeedGlobalRoute() {
  const { t } = useTranslation();
  usePageTitle(t('feed.global.title'));
  const language = useUI((st) => st.language);
  const [sort, setSort] = useState<FeedSort>('recommended');
  const q = useInfiniteQuery({
    queryKey: qk.feed.global(language, sort),
    queryFn: ({ pageParam }) =>
      feedApi.global({ cursor: pageParam, limit: 20, lang: language, sort }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const trending = useQuery({
    queryKey: qk.tags.trending,
    queryFn: () => tagsApi.trending(8),
  });

  const items = useMemo(() => flattenPostPages(q.data), [q.data]);

  return (
    <div className={s.page}>
      <header className={s.pageHeader}>
        <div>
          <h1 className={s.title}>{t('feed.global.title')}</h1>
          <span className={s.lede}>{t('feed.global.lede')}</span>
        </div>
        <FeedLayoutToggle />
      </header>

      {/*
        The sort switch lives on the trending row but must not depend on it:
        it used to be nested inside the `trending.data.length > 0` branch, so
        an empty or failed trending query silently removed the only way to
        switch between Recommended and Latest.
      */}
      <div className={s.trending}>
        {trending.data && trending.data.length > 0 && (
          <>
            <span className={s.trendingLabel}>{t('feed.global.trending')}</span>
            {trending.data.map((tag) => (
              <UITag key={tag.slug} to={`/tag/${tag.slug}`}>
                {tag.display}
              </UITag>
            ))}
          </>
        )}
        <div className={s.sortTabs} style={{ marginLeft: 'auto' }}>
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

      {q.isLoading && <FeedSkeletons />}

      {q.isError && (
        <EmptyState
          title={t('feed.global.error')}
          description={t('feed.global.errorDesc')}
          action={<Button onClick={() => q.refetch()}>{t('feed.global.retry')}</Button>}
        />
      )}

      {q.isSuccess && items.length === 0 && (
        <EmptyState title={t('feed.global.empty')} description={t('feed.global.emptyDesc')} />
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

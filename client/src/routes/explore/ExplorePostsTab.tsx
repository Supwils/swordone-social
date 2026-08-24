import { useEffect } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MagnifyingGlass } from '@phosphor-icons/react';
import * as postsApi from '@/api/posts.api';
import { Skeleton, EmptyState } from '@/components/primitives';
import { InfiniteScrollSentinel } from '@/components/InfiniteScrollSentinel';
import { PostCard } from '@/features/posts/PostCard';
import { useDebounce } from '@/lib/useDebounce';
import { track } from '@/lib/analytics';
import type { Paginated, PostDTO } from '@/api/types';
import s from '../explore.module.css';

export function ExplorePostsTab() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const searchInput = searchParams.get('q') ?? '';
  const debouncedQ = useDebounce(searchInput, 300);

  useEffect(() => {
    if (debouncedQ) track('search_query', { q: debouncedQ });
  }, [debouncedQ]);

  const q = useInfiniteQuery({
    queryKey: ['posts', 'search', debouncedQ],
    queryFn: ({ pageParam, signal }) =>
      postsApi.searchPosts({ q: debouncedQ || undefined, cursor: pageParam as string | undefined, signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: Paginated<PostDTO>) => last.nextCursor,
    enabled: true,
  });

  const posts = q.data?.pages.flatMap((p) => p.items) ?? [];
  const isDebouncing = searchInput !== debouncedQ;

  const setQ = (v: string) => {
    const next = new URLSearchParams(searchParams);
    if (v) next.set('q', v);
    else next.delete('q');
    setSearchParams(next, { replace: true });
  };

  return (
    <>
      <div className={s.searchBar}>
        <MagnifyingGlass size={16} className={s.searchIcon} aria-hidden />
        <input
          type="search"
          className={s.searchInput}
          placeholder={t('explore.searchPosts')}
          aria-label={t('explore.searchPosts')}
          value={searchInput}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
      </div>

      <div style={{ opacity: isDebouncing ? 0.5 : 1, transition: 'opacity 150ms' }}>
        {q.isLoading && (
          <div className={s.postList}>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className={s.postSkeleton}>
                <Skeleton variant="circle" width={40} height={40} />
                <div className={s.skeletonLines}>
                  <Skeleton variant="text" width={120} />
                  <Skeleton variant="text" width="100%" />
                  <Skeleton variant="text" width="80%" />
                </div>
              </div>
            ))}
          </div>
        )}

        {q.isSuccess && posts.length === 0 && (
          <EmptyState
            title={debouncedQ ? t('explore.noResults') : t('explore.startSearch')}
            description={debouncedQ ? t('explore.noResultsDesc') : t('explore.startSearchDesc')}
          />
        )}

        {posts.length > 0 && (
          <div className={s.postList}>
            {posts.map((post) => (
              <PostCard key={post.id} post={post} />
            ))}
          </div>
        )}

        <InfiniteScrollSentinel
          hasNextPage={q.hasNextPage}
          isFetching={q.isFetchingNextPage}
          onLoadMore={() => q.fetchNextPage()}
        />
      </div>
    </>
  );
}

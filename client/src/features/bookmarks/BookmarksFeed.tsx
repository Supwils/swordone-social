import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as bookmarksApi from '@/api/bookmarks.api';
import { qk } from '@/api/queryKeys';
import type { Paginated, PostDTO } from '@/api/types';
import { EmptyState, PostCardSkeleton } from '@/components/primitives';
import { InfiniteScrollSentinel } from '@/components/InfiniteScrollSentinel';
import { PostCard } from '@/features/posts/PostCard';

export function BookmarksFeed() {
  const { t } = useTranslation();
  const q = useInfiniteQuery({
    queryKey: qk.bookmarks.list,
    queryFn: ({ pageParam, signal }) =>
      bookmarksApi.listBookmarks({ cursor: pageParam as string | undefined, signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: Paginated<PostDTO>) => last.nextCursor,
  });

  const posts = q.data?.pages.flatMap((p) => p.items) ?? [];

  if (q.isLoading) {
    return (
      <>
        <PostCardSkeleton />
        <PostCardSkeleton />
      </>
    );
  }

  if (q.isError) {
    return <EmptyState title={t('bookmarks.error')} description={t('bookmarks.errorDesc')} />;
  }

  if (q.isSuccess && posts.length === 0) {
    return <EmptyState title={t('bookmarks.empty')} description={t('bookmarks.emptyDesc')} />;
  }

  return (
    <>
      {posts.map((post) => (
        <PostCard key={post.id} post={post} />
      ))}

      <InfiniteScrollSentinel
        hasNextPage={q.hasNextPage}
        isFetching={q.isFetchingNextPage}
        onLoadMore={() => q.fetchNextPage()}
      />
    </>
  );
}

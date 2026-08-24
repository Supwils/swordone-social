import type { PostDTO } from '@/api/types';
import { InfiniteScrollSentinel } from '@/components/InfiniteScrollSentinel';
import { PostCardSkeleton } from '@/components/primitives';
import { ImmersiveWall } from './ImmersiveWall';
import { PostCard } from './PostCard';
import { VirtualPostList } from './VirtualPostList';
import { useUI } from '@/stores/ui.store';
import s from '@/routes/feed.module.css';

interface StreamProps {
  items: PostDTO[];
  hasNextPage: boolean | undefined;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}

/** Loading placeholders that match the current list/folio/immersive layout. */
export function FeedSkeletons({ count = 4 }: { count?: number }) {
  const layout = useUI((st) => st.feedLayout);
  return (
    <div
      className={layout === 'list' ? s.postList : s.postGrid}
      data-testid="feed-skeletons"
    >
      {Array.from({ length: count }, (_, i) => (
        <PostCardSkeleton key={i} />
      ))}
    </div>
  );
}

/**
 * Shared post river. Folio (grid) puts two compact cards on screen at once;
 * list keeps the single reading column, virtualized; immersive scatters the
 * page into a wall and reads one post at a time.
 */
export function FeedStream({ items, hasNextPage, isFetchingNextPage, onLoadMore }: StreamProps) {
  const layout = useUI((st) => st.feedLayout);

  if (layout === 'immersive') {
    return (
      <ImmersiveWall
        items={items}
        hasNextPage={Boolean(hasNextPage)}
        isFetchingNextPage={isFetchingNextPage}
        onLoadMore={onLoadMore}
      />
    );
  }

  if (layout === 'grid') {
    return (
      <>
        <div className={s.postGrid} data-testid="feed-grid">
          {items.map((post) => (
            <PostCard key={post.id} post={post} compact />
          ))}
        </div>
        <InfiniteScrollSentinel
          hasNextPage={Boolean(hasNextPage)}
          isFetching={isFetchingNextPage}
          onLoadMore={onLoadMore}
        />
      </>
    );
  }

  return (
    <VirtualPostList
      items={items}
      hasNextPage={Boolean(hasNextPage)}
      isFetchingNextPage={isFetchingNextPage}
      onLoadMore={onLoadMore}
    />
  );
}

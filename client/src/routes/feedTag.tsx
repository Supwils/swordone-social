import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import * as feedApi from '@/api/feed.api';
import * as tagsApi from '@/api/tags.api';
import { qk } from '@/api/queryKeys';
import { EmptyState } from '@/components/primitives';
import { FeedLayoutToggle } from '@/features/posts/FeedLayoutToggle';
import { FeedSkeletons, FeedStream } from '@/features/posts/FeedStream';
import { useUI } from '@/stores/ui.store';
import s from './feedTag.module.css';
import { usePageTitle } from '@/lib/usePageTitle';

export default function FeedTagRoute() {
  const { slug = '' } = useParams<{ slug: string }>();
  const language = useUI((st) => st.language);
  const { t } = useTranslation();
  usePageTitle(`#${slug}`);

  const feedQ = useInfiniteQuery({
    queryKey: qk.feed.byTag(slug, language),
    queryFn: ({ pageParam }) =>
      feedApi.byTag(slug, { cursor: pageParam, limit: 20, lang: language }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: Boolean(slug),
  });

  const tagQ = useQuery({
    queryKey: qk.tags.bySlug(slug),
    queryFn: () => tagsApi.getBySlug(slug),
    enabled: Boolean(slug),
    staleTime: 5 * 60 * 1000,
  });

  const items = feedQ.data?.pages.flatMap((p) => p.items) ?? [];
  const tag = tagQ.data;
  const hasMeta = Boolean(tag?.description || tag?.coverImage);
  const isArchived = tag?.status === 'archived';

  const title = <h1>#{tag?.display ?? slug}</h1>;
  const toggle = <FeedLayoutToggle />;

  return (
    <div className={s.page}>
      {hasMeta ? (
        <header className={s.richHeader}>
          {tag?.coverImage && (
            <div className={s.cover} style={{ backgroundImage: `url(${tag.coverImage})` }} />
          )}
          <div className={s.headerBody}>
            <div className={s.headerRow}>
              {title}
              {toggle}
            </div>
            {tag?.description && <p className={s.description}>{tag.description}</p>}
            {tag?.postCount != null && (
              <span className={s.postCount}>
                {tag.postCount.toLocaleString()} {t('explore.topicsPostCount')}
              </span>
            )}
            {isArchived && <span className={s.archivedBadge}>{t('explore.topicArchived')}</span>}
          </div>
        </header>
      ) : (
        <header className={s.simpleHeader}>
          {title}
          {toggle}
        </header>
      )}

      {feedQ.isLoading && <FeedSkeletons />}

      {feedQ.isError && (
        <EmptyState
          title="Tag not found"
          description="This tag doesn't exist or nobody has used it yet."
        />
      )}

      {feedQ.isSuccess && items.length === 0 && (
        <EmptyState title="Quiet here." description={`No recent posts on #${slug}.`} />
      )}

      {feedQ.isSuccess && items.length > 0 && (
        <FeedStream
          items={items}
          hasNextPage={feedQ.hasNextPage}
          isFetchingNextPage={feedQ.isFetchingNextPage}
          onLoadMore={() => {
            void feedQ.fetchNextPage();
          }}
        />
      )}
    </div>
  );
}

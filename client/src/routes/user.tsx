import React, { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Robot } from '@phosphor-icons/react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import * as usersApi from '@/api/users.api';
import * as feedApi from '@/api/feed.api';
import * as followsApi from '@/api/follows.api';
import * as messagesApi from '@/api/messages.api';
import { qk } from '@/api/queryKeys';
import { BookmarksFeed } from '@/features/bookmarks/BookmarksFeed';
import { useSession } from '@/stores/session.store';
import { PostCard } from '@/features/posts/PostCard';
import { FollowListModal } from '@/features/users/FollowListModal';
import { AgentDriftWidget } from '@/features/lab/AgentDriftWidget';
import type { UserDTO, ApiError } from '@/api/types';
import { Avatar, Button, EmptyState, PostCardSkeleton, Skeleton } from '@/components/primitives';
import { InfiniteScrollSentinel } from '@/components/InfiniteScrollSentinel';
import s from './user.module.css';
import { usePageTitle } from '@/lib/usePageTitle';

// Positions form a loose orbit around the avatar (top-center of header)
const STICKER_POSITIONS = [
  { x: '15%', y: '5%', rot: -8 },
  { x: '65%', y: '3%', rot: 7 },
  { x: '7%', y: '28%', rot: 13 },
  { x: '77%', y: '22%', rot: -5 },
  { x: '12%', y: '54%', rot: -12 },
  { x: '71%', y: '50%', rot: 9 },
  { x: '26%', y: '68%', rot: 5 },
  { x: '60%', y: '66%', rot: -9 },
  { x: '32%', y: '10%', rot: 10 },
  { x: '73%', y: '38%', rot: -4 },
];

// Soft, muted pastels — cohesive with the warm off-white design
const STICKER_COLORS = [
  { bg: 'rgba(154, 189, 138, 0.25)', border: 'rgba(120, 162, 104, 0.38)' },
  { bg: 'rgba(200, 155, 155, 0.25)', border: 'rgba(170, 118, 118, 0.38)' },
  { bg: 'rgba(150, 148, 200, 0.25)', border: 'rgba(115, 112, 170, 0.38)' },
  { bg: 'rgba(200, 175, 118, 0.25)', border: 'rgba(170, 145, 86, 0.38)' },
  { bg: 'rgba(118, 165, 200, 0.25)', border: 'rgba(86, 132, 170, 0.38)' },
  { bg: 'rgba(118, 192, 175, 0.25)', border: 'rgba(86, 162, 145, 0.38)' },
  { bg: 'rgba(200, 188, 118, 0.25)', border: 'rgba(170, 158, 86, 0.38)' },
  { bg: 'rgba(178, 138, 200, 0.25)', border: 'rgba(148, 104, 170, 0.38)' },
];

function TagWallpaper({ tags }: { tags: string[] }) {
  const { t } = useTranslation();
  return (
    <div className={s.tagWallpaper}>
      {tags.map((tag, i) => {
        const pos = STICKER_POSITIONS[i % STICKER_POSITIONS.length];
        const col = STICKER_COLORS[i % STICKER_COLORS.length];
        return (
          <Link
            key={tag}
            to={`/explore?tab=people&tag=${encodeURIComponent(tag)}`}
            className={s.stickerTag}
            style={
              {
                left: pos.x,
                top: pos.y,
                '--rot': `${pos.rot}deg`,
                transform: `rotate(${pos.rot}deg)`,
                background: col.bg,
                border: `1px solid ${col.border}`,
              } as React.CSSProperties
            }
          >
            {t(`tags.labels.${tag}`, tag)}
          </Link>
        );
      })}
    </div>
  );
}

export default function UserRoute() {
  const { t } = useTranslation();
  const { username = '' } = useParams<{ username: string }>();
  usePageTitle(username ? `@${username}` : undefined);
  const [searchParams, setSearchParams] = useSearchParams();
  const me = useSession((st) => st.user);
  const qc = useQueryClient();
  const nav = useNavigate();
  const [followModal, setFollowModal] = useState<'followers' | 'following' | null>(null);

  const user = useQuery({
    queryKey: qk.users.byUsername(username),
    queryFn: () => usersApi.getByUsername(username),
    enabled: Boolean(username),
  });

  const isSelf = Boolean(me && user.data && me.id === user.data.id);
  const activeTab = isSelf && searchParams.get('tab') === 'bookmarks' ? 'bookmarks' : 'posts';

  const posts = useInfiniteQuery({
    queryKey: qk.users.posts(username),
    queryFn: ({ pageParam }) => feedApi.byUser(username, { cursor: pageParam, limit: 20 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: Boolean(username) && activeTab === 'posts',
  });

  const followStatus = useQuery({
    queryKey: qk.users.followStatus(username),
    queryFn: () => followsApi.checkFollowing(username),
    enabled: Boolean(me && !isSelf && user.data),
    staleTime: 30_000,
  });
  const isFollowingUser = followStatus.data ?? false;

  const message = useMutation({
    mutationFn: () => messagesApi.findOrCreate(username),
    onSuccess: (convo) => nav(`/messages/${convo.id}`),
    onError: (err) => toast.error((err as unknown as ApiError).message),
  });

  // A follow changes what the Following feed contains and who appears in both
  // follow lists. Those caches sit under a 30s staleTime, so without an
  // explicit invalidation a user who followed someone and went straight back
  // to /feed kept seeing the pre-follow river.
  const invalidateFollowDependents = () => {
    void qc.invalidateQueries({ queryKey: ['feed', 'following'] });
    void qc.invalidateQueries({ queryKey: qk.users.followers(username) });
    if (me) void qc.invalidateQueries({ queryKey: qk.users.following(me.username) });
  };

  const follow = useMutation({
    mutationFn: () => followsApi.follow(username),
    onSuccess: () => {
      qc.setQueryData<UserDTO>(qk.users.byUsername(username), (old) =>
        old ? { ...old, followerCount: old.followerCount + 1 } : old,
      );
      qc.setQueryData(qk.users.followStatus(username), true);
      invalidateFollowDependents();
      toast.success(`Following @${username}`);
    },
    onError: (err) => toast.error((err as unknown as ApiError).message),
  });

  const unfollow = useMutation({
    mutationFn: () => followsApi.unfollow(username),
    onSuccess: () => {
      qc.setQueryData<UserDTO>(qk.users.byUsername(username), (old) =>
        old ? { ...old, followerCount: Math.max(0, old.followerCount - 1) } : old,
      );
      qc.setQueryData(qk.users.followStatus(username), false);
      invalidateFollowDependents();
      toast.success(`Unfollowed @${username}`);
    },
    onError: (err) => toast.error((err as unknown as ApiError).message),
  });

  if (user.isLoading) {
    return (
      <div className={s.page}>
        <div className={s.header}>
          <div className={s.headerContent}>
            <Skeleton variant="circle" width={96} height={96} />
            <Skeleton variant="text-lg" width={180} />
            <Skeleton variant="text" width={120} />
          </div>
        </div>
      </div>
    );
  }

  if (user.isError || !user.data) {
    return (
      <EmptyState
        title={t('profile.notFound')}
        description={t('profile.notFoundDesc', { username })}
      />
    );
  }

  const u = user.data;
  const hasTags = u.profileTags && u.profileTags.length > 0;
  const postItems = posts.data?.pages.flatMap((p) => p.items) ?? [];

  const setActiveTab = (tab: 'posts' | 'bookmarks') => {
    const next = new URLSearchParams(searchParams);
    if (tab === 'posts') next.delete('tab');
    else next.set('tab', tab);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className={s.page}>
      <header className={s.header}>
        {hasTags && <TagWallpaper tags={u.profileTags!} />}

        <div className={s.headerContent}>
          <Avatar src={u.avatarUrl} name={u.displayName || u.username} size="xl" alt="" />
          <div>
            <h1 className={s.name}>{u.displayName || u.username}</h1>
            <div className={s.handle}>@{u.username}</div>
            {u.owner && (
              <Link to={`/u/${u.owner.username}`} className={s.ownedBy}>
                <Robot size={12} weight="fill" aria-hidden />
                {t('profile.ownedBy', { username: u.owner.username })}
              </Link>
            )}
          </div>
          {u.headline && <p className={s.headline}>{u.headline}</p>}
          {u.bio && <p className={s.bio}>{u.bio}</p>}
          <AgentDriftWidget username={u.username} enabled={u.isAgent} />
          <div className={s.meta}>
            <span>
              <strong>{u.postCount}</strong> {t('profile.posts')}
            </span>
            <button type="button" className={s.metaBtn} onClick={() => setFollowModal('followers')}>
              <strong>{u.followerCount}</strong> {t('profile.followers')}
            </button>
            <button type="button" className={s.metaBtn} onClick={() => setFollowModal('following')}>
              <strong>{u.followingCount}</strong> {t('profile.following')}
            </button>
          </div>
          {!isSelf && me && (
            <div className={s.actions}>
              {isFollowingUser ? (
                <Button
                  variant="subtle"
                  onClick={() => unfollow.mutate()}
                  disabled={unfollow.isPending || followStatus.isLoading}
                >
                  {t('profile.unfollow')}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  onClick={() => follow.mutate()}
                  disabled={follow.isPending || followStatus.isLoading}
                >
                  {t('profile.follow')}
                </Button>
              )}
              <Button variant="ghost" onClick={() => message.mutate()} disabled={message.isPending}>
                {t('profile.message')}
              </Button>
            </div>
          )}
        </div>
      </header>

      {isSelf ? (
        <div className={s.sectionTabs} role="tablist" aria-label={t('profile.posts')}>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'posts'}
            className={`${s.sectionTab} ${activeTab === 'posts' ? s.sectionTabActive : ''}`}
            onClick={() => setActiveTab('posts')}
          >
            {t('profile.posts')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'bookmarks'}
            className={`${s.sectionTab} ${activeTab === 'bookmarks' ? s.sectionTabActive : ''}`}
            onClick={() => setActiveTab('bookmarks')}
          >
            {t('nav.bookmarks')}
          </button>
        </div>
      ) : (
        <h2 className={s.sectionTitle}>{t('profile.posts')}</h2>
      )}

      {activeTab === 'bookmarks' ? (
        <BookmarksFeed />
      ) : (
        <>
          {posts.isLoading && (
            <>
              <PostCardSkeleton />
              <PostCardSkeleton />
            </>
          )}

          {posts.isSuccess && postItems.length === 0 && (
            <EmptyState title="No posts yet." description="Nothing to see here — yet." />
          )}

          {postItems.map((post) => (
            <PostCard key={post.id} post={post} />
          ))}

          <InfiniteScrollSentinel
            hasNextPage={posts.hasNextPage}
            isFetching={posts.isFetchingNextPage}
            onLoadMore={() => posts.fetchNextPage()}
          />
        </>
      )}

      {followModal && (
        <FollowListModal
          username={u.username}
          type={followModal}
          open={Boolean(followModal)}
          onClose={() => setFollowModal(null)}
        />
      )}
    </div>
  );
}

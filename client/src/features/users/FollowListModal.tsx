import { useEffect, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MagnifyingGlass } from '@phosphor-icons/react';
import * as followsApi from '@/api/follows.api';
import { qk } from '@/api/queryKeys';
import { AccountBadge, Avatar, Skeleton, Dialog } from '@/components/primitives';
import { InfiniteScrollSentinel } from '@/components/InfiniteScrollSentinel';
import s from './FollowListModal.module.css';

interface Props {
  username: string;
  type: 'followers' | 'following';
  open: boolean;
  onClose: () => void;
}

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

export function FollowListModal({ username, type, open, onClose }: Props) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search.trim(), 300);
  const isDebouncing = search.trim() !== debouncedSearch;

  const baseKey =
    type === 'followers' ? qk.users.followers(username) : qk.users.following(username);

  const q = useInfiniteQuery({
    queryKey: [...baseKey, debouncedSearch],
    queryFn: ({ pageParam, signal }) => {
      const fn = type === 'followers' ? followsApi.listFollowers : followsApi.listFollowing;
      return fn(
        username,
        { cursor: pageParam, limit: 40, search: debouncedSearch || undefined },
        signal,
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: open,
  });

  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const isSearchMode = Boolean(debouncedSearch);

  const title = type === 'followers' ? t('profile.followersModal') : t('profile.followingModal');

  function handleClose() {
    onClose();
    setSearch('');
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) handleClose();
      }}
      title={title}
      contentClassName={s.modal}
    >
      <div className={s.searchWrap}>
        <MagnifyingGlass className={s.searchIcon} size={14} weight="regular" aria-hidden />
        <input
          className={s.searchInput}
          type="text"
          placeholder={t('profile.searchUsers')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        {search && (
          <button
            className={s.searchClear}
            type="button"
            onClick={() => setSearch('')}
            aria-label={t('common.clear')}
          >
            ×
          </button>
        )}
      </div>

      <div
        className={s.list}
        style={{ opacity: isDebouncing ? 0.5 : 1, transition: 'opacity 150ms' }}
      >
        {q.isLoading &&
          Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className={s.skeletonRow}>
              <Skeleton variant="circle" width={36} height={36} />
              <div className={s.skeletonLines}>
                <Skeleton variant="text" width={100} />
                <Skeleton variant="text" width={70} />
              </div>
            </div>
          ))}

        {!q.isLoading && items.length === 0 && (
          <p className={s.empty}>
            {isSearchMode
              ? t('profile.noSearchResults')
              : type === 'followers'
                ? t('profile.noFollowers')
                : t('profile.noFollowing')}
          </p>
        )}

        {items.map((user) => (
          <Link
            key={user.id}
            to={`/u/${user.username}`}
            className={s.userRow}
            onClick={handleClose}
          >
            <Avatar
              src={user.avatarUrl}
              name={user.displayName || user.username}
              size="sm"
              alt=""
            />
            <div className={s.userInfo}>
              <span className={s.displayName}>
                {user.displayName || user.username}
                {(user.isAgent || user.archivedAt) && (
                  <AccountBadge
                    isAgent={user.isAgent}
                    agentBackend={user.agentBackend}
                    archivedAt={user.archivedAt}
                  />
                )}
              </span>
              <span className={s.handle}>@{user.username}</span>
            </div>
          </Link>
        ))}

        {!isSearchMode && (
          <InfiniteScrollSentinel
            hasNextPage={q.hasNextPage}
            isFetching={q.isFetchingNextPage}
            onLoadMore={() => q.fetchNextPage()}
          />
        )}
      </div>
    </Dialog>
  );
}

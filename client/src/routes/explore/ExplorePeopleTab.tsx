import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import * as usersApi from '@/api/users.api';
import { AccountBadge, Avatar, Skeleton } from '@/components/primitives';
import type { UserLiteDTO } from '@/api/types';
import s from '../explore.module.css';

function UserCard({ user }: { user: UserLiteDTO }) {
  const { t } = useTranslation();
  return (
    <Link to={`/u/${user.username}`} className={s.card}>
      <Avatar src={user.avatarUrl} name={user.displayName || user.username} size="md" alt="" />
      <div className={s.cardBody}>
        <div className={s.cardName}>
          {user.displayName || user.username}
          {(user.isAgent || user.archivedAt) && (
            <AccountBadge
              isAgent={user.isAgent}
              agentBackend={user.agentBackend}
              archivedAt={user.archivedAt}
            />
          )}
        </div>
        <div className={s.cardHandle}>@{user.username}</div>
        {user.headline && <p className={s.cardHeadline}>{user.headline}</p>}
        {user.profileTags && user.profileTags.length > 0 && (
          <div className={s.cardTags}>
            {user.profileTags.slice(0, 5).map((tag) => (
              <span key={tag} className={s.cardTag}>{t(`tags.labels.${tag}`, tag)}</span>
            ))}
          </div>
        )}
      </div>
    </Link>
  );
}

export function ExplorePeopleTab() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTag = searchParams.get('tag') ?? '';
  const [agentsOnly, setAgentsOnly] = useState(false);

  const tagsQuery = useQuery({
    queryKey: ['profile-tags'],
    queryFn: usersApi.getPopularProfileTags,
  });

  const usersQuery = useQuery({
    queryKey: ['users', 'explore', activeTag],
    queryFn: ({ signal }) => usersApi.browseUsers(40, activeTag || undefined, signal),
  });

  const allUsers = usersQuery.data ?? [];
  const displayed = agentsOnly ? allUsers.filter((u) => u.isAgent) : allUsers;

  const setTag = (tag: string) => {
    const next = new URLSearchParams(searchParams);
    if (tag) next.set('tag', tag);
    else next.delete('tag');
    setSearchParams(next);
  };

  return (
    <>
      <div className={s.filters}>
        <div className={s.tagFilters}>
          <button
            type="button"
            className={`${s.filterPill} ${!activeTag ? s.filterPillActive : ''}`}
            onClick={() => setTag('')}
            aria-pressed={!activeTag}
          >
            {t('explore.all')}
          </button>
          {tagsQuery.data?.map(({ tag }) => (
            <button
              key={tag}
              type="button"
              className={`${s.filterPill} ${activeTag === tag ? s.filterPillActive : ''}`}
              onClick={() => setTag(tag)}
              aria-pressed={activeTag === tag}
            >
              {t(`tags.labels.${tag}`, tag)}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`${s.agentToggle} ${agentsOnly ? s.agentToggleActive : ''}`}
          onClick={() => setAgentsOnly((v) => !v)}
          aria-pressed={agentsOnly}
        >
          {t('explore.agentsOnly')}
        </button>
      </div>

      {usersQuery.isLoading && (
        <div className={s.grid}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className={s.cardSkeleton}>
              <Skeleton variant="circle" width={40} height={40} />
              <div className={s.skeletonLines}>
                <Skeleton variant="text" width={120} />
                <Skeleton variant="text" width={80} />
              </div>
            </div>
          ))}
        </div>
      )}

      {usersQuery.isSuccess && displayed.length === 0 && (
        <div className={s.empty}>
          {agentsOnly ? t('explore.emptyAgents') : t('explore.empty')}
        </div>
      )}

      {usersQuery.isSuccess && displayed.length > 0 && (
        <div className={s.grid}>
          {displayed.map((user) => (
            <UserCard key={user.id} user={user} />
          ))}
        </div>
      )}
    </>
  );
}

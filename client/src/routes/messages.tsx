import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import * as messagesApi from '@/api/messages.api';
import { qk } from '@/api/queryKeys';
import { useSession } from '@/stores/session.store';
import { Avatar, EmptyState, ConversationSkeleton } from '@/components/primitives';
import { InfiniteScrollSentinel } from '@/components/InfiniteScrollSentinel';
import { formatRelative } from '@/lib/formatDate';
import type { ApiError, ConversationDTO, UserLiteDTO } from '@/api/types';
import { useUserSearch } from '@/features/users/useUserSearch';
import s from './messages.module.css';
import { usePageTitle } from '@/lib/usePageTitle';

export default function MessagesRoute() {
  const { t } = useTranslation();
  usePageTitle(t('messages.title'));
  const me = useSession((st) => st.user);
  const nav = useNavigate();
  const qc = useQueryClient();

  const q = useInfiniteQuery({
    queryKey: qk.conversations.list,
    queryFn: ({ pageParam }) => messagesApi.listConversations({ cursor: pageParam, limit: 30 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const start = useMutation({
    mutationFn: (username: string) => messagesApi.findOrCreate(username),
    onSuccess: (convo) => {
      qc.invalidateQueries({ queryKey: qk.conversations.list });
      nav(`/messages/${convo.id}`);
    },
    onError: (err) => toast.error((err as unknown as ApiError).message),
  });

  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className={s.page}>
      <header className={s.pageHeader}>
        <h1 className={s.title}>{t('messages.title')}</h1>
      </header>

      <UserSearchCompose
        onSelect={(username) => start.mutate(username)}
        loading={start.isPending}
      />

      {q.isLoading && (
        <>
          <ConversationSkeleton />
          <ConversationSkeleton />
          <ConversationSkeleton />
          <ConversationSkeleton />
        </>
      )}

      {q.isSuccess && items.length === 0 && (
        <EmptyState title={t('messages.empty')} description={t('messages.emptyDesc')} />
      )}

      {items.map((c) => (
        <ConversationRow key={c.id} convo={c} selfId={me?.id ?? ''} />
      ))}

      <InfiniteScrollSentinel
        hasNextPage={q.hasNextPage}
        isFetching={q.isFetchingNextPage}
        onLoadMore={() => q.fetchNextPage()}
      />
    </div>
  );
}

/* ---- User search compose ---- */

function UserSearchCompose({
  onSelect,
  loading,
}: {
  onSelect: (username: string) => void;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const trimmed = query.trim();

  const search = useUserSearch(trimmed, { staleTime: 15_000, keepPrevious: true });

  const results: UserLiteDTO[] = search.data ?? [];

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const pick = (user: UserLiteDTO) => {
    setQuery('');
    setOpen(false);
    onSelect(user.username);
  };

  return (
    <div className={s.searchWrap} ref={wrapRef}>
      <div className={s.searchRow}>
        <input
          ref={inputRef}
          type="text"
          className={s.newInput}
          placeholder={t('messages.placeholder')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          aria-label="Search users"
          aria-autocomplete="list"
          aria-expanded={open && results.length > 0}
          autoComplete="off"
        />
        {loading && <span className={s.searchSpinner} aria-hidden />}
      </div>

      {open && trimmed.length >= 1 && (
        <ul className={s.searchDropdown} role="listbox">
          {results.length === 0 && !search.isLoading && (
            <li className={s.searchEmpty}>{t('messages.noUsers')}</li>
          )}
          {results.map((u) => (
            <li key={u.id} role="option" aria-selected={false}>
              <button
                type="button"
                className={s.searchItem}
                onMouseDown={(e) => {
                  // mousedown fires before blur — prevent input losing focus before pick
                  e.preventDefault();
                  pick(u);
                }}
              >
                <Avatar src={u.avatarUrl} name={u.displayName || u.username} size="sm" alt="" />
                <div className={s.searchItemText}>
                  <span className={s.searchItemName}>{u.displayName || u.username}</span>
                  <span className={s.searchItemHandle}>@{u.username}</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---- Conversation row ---- */

function ConversationRow({ convo, selfId }: { convo: ConversationDTO; selfId: string }) {
  const { t } = useTranslation();
  const other = convo.participants.find((p) => p.id !== selfId) ?? convo.participants[0];
  if (!other) return null;
  return (
    <Link to={`/messages/${convo.id}`} className={clsx(s.row, convo.unread && s.rowUnread)}>
      <Avatar src={other.avatarUrl} name={other.displayName || other.username} size="md" alt="" />
      <div className={s.rowBody}>
        <div className={s.rowHeader}>
          <span className={s.rowName}>{other.displayName || other.username}</span>
          <time className={s.rowDate} dateTime={convo.updatedAt}>
            {formatRelative(convo.updatedAt)}
          </time>
        </div>
        <div className={s.rowPreview}>
          {convo.lastMessage
            ? convo.lastMessage.sender.id === selfId
              ? `${t('messages.you')}${convo.lastMessage.text}`
              : convo.lastMessage.text
            : t('messages.noMessages')}
        </div>
      </div>
    </Link>
  );
}

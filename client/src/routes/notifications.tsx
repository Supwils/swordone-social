import { useEffect, useRef, useState } from 'react';
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import * as notificationsApi from '@/api/notifications.api';
import { qk } from '@/api/queryKeys';
import { useRealtime } from '@/stores/realtime.store';
import { formatRelative } from '@/lib/formatDate';
import {
  Avatar,
  Button,
  Dialog,
  DialogActions,
  EmptyState,
  NotificationSkeleton,
} from '@/components/primitives';
import { InfiniteScrollSentinel } from '@/components/InfiniteScrollSentinel';
import type { ApiError, NotificationDTO, Paginated, UserLiteDTO } from '@/api/types';
import s from './notifications.module.css';
import { usePageTitle } from '@/lib/usePageTitle';

/* ---------- grouping helpers ---------- */

interface GroupedNotification {
  key: string;
  type: NotificationDTO['type'];
  actors: UserLiteDTO[];
  post?: { id: string; textPreview: string };
  comment?: { id: string; textPreview: string };
  message?: { id: string; conversationId: string };
  anyUnread: boolean;
  latestCreatedAt: string;
}

function groupNotifications(items: NotificationDTO[]): GroupedNotification[] {
  const groups = new Map<string, GroupedNotification>();

  for (const n of items) {
    // Group likes and echos by their target; keep other types individual
    let key: string;
    if (n.type === 'like' || n.type === 'echo') {
      const target = n.comment ? `comment:${n.comment.id}` : n.post ? `post:${n.post.id}` : n.id;
      key = `${n.type}:${target}`;
    } else {
      key = n.id;
    }

    const existing = groups.get(key);
    if (existing) {
      if (!existing.actors.find((a) => a.id === n.actor.id)) {
        existing.actors.push(n.actor);
      }
      if (!n.read) existing.anyUnread = true;
      if (n.createdAt > existing.latestCreatedAt) {
        existing.latestCreatedAt = n.createdAt;
      }
    } else {
      groups.set(key, {
        key,
        type: n.type,
        actors: [n.actor],
        post: n.post,
        comment: n.comment,
        message: n.message,
        anyUnread: !n.read,
        latestCreatedAt: n.createdAt,
      });
    }
  }

  return Array.from(groups.values());
}

function actorLabel(
  actors: UserLiteDTO[],
  t: (k: string, opts?: Record<string, unknown>) => string,
): string {
  if (actors.length === 1) return actors[0].displayName || actors[0].username;
  if (actors.length === 2)
    return `${actors[0].displayName || actors[0].username} ${t('notifications.and')} ${actors[1].displayName || actors[1].username}`;
  return t('notifications.actorsWithOthers', {
    first: actors[0].displayName || actors[0].username,
    count: actors.length - 1,
  });
}

/* ---------- component ---------- */

export default function NotificationsRoute() {
  const { t } = useTranslation();
  usePageTitle(t('notifications.title'));
  const qc = useQueryClient();
  const setUnread = useRealtime((st) => st.setUnreadNotifications);
  const autoMarked = useRef(false);

  const q = useInfiniteQuery({
    queryKey: qk.notifications.list,
    queryFn: ({ pageParam }) => notificationsApi.list({ cursor: pageParam, limit: 30 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const [confirmingClear, setConfirmingClear] = useState(false);

  const _markAllRead = () => {
    setUnread(0);
    qc.setQueriesData<InfiniteData<Paginated<NotificationDTO>>>(
      { queryKey: qk.notifications.list },
      (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((pg) => ({
            ...pg,
            items: pg.items.map((n) => ({ ...n, read: true })),
          })),
        };
      },
    );
  };

  const markAll = useMutation({
    mutationFn: () => notificationsApi.markRead({ all: true }),
    onMutate: _markAllRead,
    onError: () => qc.invalidateQueries({ queryKey: qk.notifications.list }),
  });

  const clearAll = useMutation({
    mutationFn: () => notificationsApi.clearAll(),
    onSuccess: () => {
      setUnread(0);
      qc.setQueryData(qk.notifications.list, { pages: [], pageParams: [] });
      setConfirmingClear(false);
      toast.success(t('notifications.cleared'));
    },
    // Without this a failed clear left the confirm dialog open with nothing
    // said — the button just re-enabled itself.
    onError: (err) => toast.error((err as unknown as ApiError).message),
  });

  const rawItems = q.data?.pages.flatMap((p) => p.items) ?? [];
  const groups = groupNotifications(rawItems);

  useEffect(() => {
    if (!q.isSuccess || autoMarked.current || !rawItems.some((n) => !n.read)) return;
    autoMarked.current = true;
    _markAllRead();
    notificationsApi.markRead({ all: true }).catch(() => {
      autoMarked.current = false;
      qc.invalidateQueries({ queryKey: qk.notifications.list });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.isSuccess, rawItems]);

  return (
    <div className={s.page}>
      <header className={s.pageHeader}>
        <h1 className={s.title}>{t('notifications.title')}</h1>
        <div className={s.headerActions}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => markAll.mutate()}
            disabled={markAll.isPending || !rawItems.some((n) => !n.read)}
          >
            {t('notifications.markAllRead')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmingClear(true)}
            disabled={rawItems.length === 0}
          >
            {t('notifications.clearAll')}
          </Button>
        </div>
      </header>

      {q.isLoading && (
        <>
          <NotificationSkeleton />
          <NotificationSkeleton />
          <NotificationSkeleton />
          <NotificationSkeleton />
          <NotificationSkeleton />
        </>
      )}

      {q.isSuccess && groups.length === 0 && (
        <EmptyState title={t('notifications.empty')} description={t('notifications.emptyDesc')} />
      )}

      {groups.map((g) => (
        <GroupedNotificationRow key={g.key} g={g} />
      ))}

      <InfiniteScrollSentinel
        hasNextPage={q.hasNextPage}
        isFetching={q.isFetchingNextPage}
        onLoadMore={() => q.fetchNextPage()}
      />

      <Dialog
        open={confirmingClear}
        onOpenChange={(open) => {
          if (!open) setConfirmingClear(false);
        }}
        title={t('notifications.confirmClear')}
        description={t('notifications.confirmClearDesc')}
      >
        <DialogActions>
          <Button variant="ghost" onClick={() => setConfirmingClear(false)}>
            {t('post.cancel')}
          </Button>
          <Button variant="danger" onClick={() => clearAll.mutate()} disabled={clearAll.isPending}>
            {t('notifications.clearAll')}
          </Button>
        </DialogActions>
      </Dialog>
    </div>
  );
}

function GroupedNotificationRow({ g }: { g: GroupedNotification }) {
  const { t } = useTranslation();
  const href = linkFor(g);
  const verb = verbFor(g, t);
  const label = actorLabel(g.actors, t);
  const visibleAvatars = g.actors.slice(0, 3);

  const content = (
    <div className={s.body}>
      <div className={s.text}>
        <span className={s.strong}>{label}</span> {verb}
      </div>
      {(g.post?.textPreview || g.comment?.textPreview) && (
        <div className={s.preview}>"{g.comment?.textPreview ?? g.post?.textPreview}"</div>
      )}
    </div>
  );

  const avatarSection =
    g.actors.length === 1 ? (
      <Link to={`/u/${g.actors[0].username}`} aria-label={label}>
        <Avatar
          src={g.actors[0].avatarUrl}
          name={g.actors[0].displayName || g.actors[0].username}
          size="md"
          alt=""
        />
      </Link>
    ) : (
      <div className={s.avatarStack}>
        {visibleAvatars.map((actor, i) => (
          <div
            key={actor.id}
            className={s.stackedAvatar}
            style={{ zIndex: visibleAvatars.length - i }}
          >
            <Avatar
              src={actor.avatarUrl}
              name={actor.displayName || actor.username}
              size="sm"
              alt=""
            />
          </div>
        ))}
      </div>
    );

  const row = (
    <article className={clsx(s.item, g.anyUnread && s.itemUnread)}>
      {avatarSection}
      {content}
      <time className={s.date} dateTime={g.latestCreatedAt}>
        {formatRelative(g.latestCreatedAt)}
      </time>
    </article>
  );

  return href ? <Link to={href}>{row}</Link> : row;
}

function verbFor(g: GroupedNotification, t: (k: string) => string): string {
  switch (g.type) {
    case 'like':
      return g.comment ? t('notifications.likedComment') : t('notifications.likedPost');
    case 'comment':
      return t('notifications.commentedOn');
    case 'reply':
      return t('notifications.replied');
    case 'follow':
      return t('notifications.followed');
    case 'mention':
      return t('notifications.mentioned');
    case 'message':
      return t('notifications.messagedYou');
    case 'echo':
      return t('notifications.echoedPost');
  }
}

function linkFor(g: GroupedNotification): string | null {
  if (g.type === 'follow' && g.actors.length === 1) return `/u/${g.actors[0].username}`;
  if (g.type === 'message' && g.message) return `/messages/${g.message.conversationId}`;
  if (g.post) return `/p/${g.post.id}`;
  return null;
}

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { useSession } from '@/stores/session.store';
import { useRealtime } from '@/stores/realtime.store';
import { qk } from '@/api/queryKeys';
import { prependMessage } from '@/lib/messageCache';
import * as notificationsApi from '@/api/notifications.api';
import * as messagesApi from '@/api/messages.api';
import {
  connectRealtime,
  disconnectRealtime,
  getSocket,
} from '@/api/realtime';
import type {
  NotificationDTO,
  MessageDTO,
  Paginated,
} from '@/api/types';

/**
 * Connects the socket once we know who the user is, subscribes to events,
 * and bridges them into TanStack Query cache + Zustand unread counts.
 */
export function RealtimeBridge() {
  const user = useSession((s) => s.user);
  const setConnected = useRealtime((s) => s.setConnected);
  const setUnreadN = useRealtime((s) => s.setUnreadNotifications);
  const incUnreadN = useRealtime((s) => s.incUnreadNotifications);
  const setUnreadC = useRealtime((s) => s.setUnreadConversations);
  const incUnreadC = useRealtime((s) => s.incUnreadConversations);
  const incNewFeed = useRealtime((s) => s.incNewFeedPostCount);
  const resetNewFeed = useRealtime((s) => s.resetNewFeedPostCount);
  const qc = useQueryClient();

  useEffect(() => {
    if (!user) {
      disconnectRealtime();
      setConnected(false);
      setUnreadN(0);
      setUnreadC(0);
      resetNewFeed();
      return;
    }

    const socket = connectRealtime();

    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);

    const onNotification = (raw: unknown) => {
      const payload = raw as NotificationDTO;
      // Upsert into the cached list if present.
      qc.setQueryData<{ pages: Paginated<NotificationDTO>[]; pageParams: unknown[] }>(
        qk.notifications.list,
        (old) => {
          if (!old) return old;
          const dedupedPages = old.pages.map((page) => ({
            ...page,
            items: page.items.filter((item) => item.id !== payload.id),
          }));
          const [first, ...rest] = dedupedPages;
          if (!first) return old;
          return {
            ...old,
            pages: [{ ...first, items: [payload, ...first.items] }, ...rest],
          };
        },
      );
      // Local-only increment — avoids HTTP roundtrip per push.
      // Authoritative count is reseeded on mount, on focus, and on read events.
      incUnreadN(1);
      toast(summarizeNotification(payload));
    };

    const onNotificationRead = (raw: unknown) => {
      const payload = raw as { ids: string[] | 'all' };
      qc.invalidateQueries({ queryKey: qk.notifications.list });
      // Recompute unread count authoritatively (state changed on server)
      notificationsApi.unreadCount().then(setUnreadN).catch(() => undefined);
      void payload;
    };

    const onMessage = (raw: unknown) => {
      const payload = raw as MessageDTO;
      // Append to the message list cache if we have it
      qc.setQueryData<{ pages: Paginated<MessageDTO>[]; pageParams: unknown[] }>(
        qk.conversations.messages(payload.conversationId),
        // Messages are reverse-chron (newest first) in each page. Do NOT
        // materialise a cache here — a thread nobody is looking at should not
        // gain one from a background frame.
        (old) => (old ? prependMessage(old, payload) : old),
      );
      // Bump conversation in list cache
      qc.invalidateQueries({ queryKey: qk.conversations.list });
      // Suppress toast if user is already viewing this conversation
      const onThisThread = window.location.pathname === `/messages/${payload.conversationId}`;
      if (payload.sender.id !== user.id && !onThisThread) {
        toast(`@${payload.sender.username}: ${preview(payload.text)}`);
        // Local-only bump — server count reseeded on focus / read.
        incUnreadC(1);
      }
    };

    const onPostNew = () => {
      incNewFeed();
    };

    const onConversationUpdate = () => {
      qc.invalidateQueries({ queryKey: qk.conversations.list });
      messagesApi.unreadCount().then(setUnreadC).catch(() => undefined);
    };

    const onMessageRead = (raw: unknown) => {
      const payload = raw as { conversationId: string; userId: string };
      qc.setQueryData<{ pages: Paginated<MessageDTO>[]; pageParams: unknown[] }>(
        qk.conversations.messages(payload.conversationId),
        (old) => {
          if (!old) return old;
          return {
            ...old,
            pages: old.pages.map((pg) => ({
              ...pg,
              items: pg.items.map((m) =>
                m.readBy.includes(payload.userId)
                  ? m
                  : { ...m, readBy: [...m.readBy, payload.userId] },
              ),
            })),
          };
        },
      );
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('notification', onNotification);
    socket.on('notification:read', onNotificationRead);
    socket.on('message', onMessage);
    socket.on('message:read', onMessageRead);
    socket.on('conversation:update', onConversationUpdate);
    socket.on('post:new', onPostNew);

    // Seed unread counts once on mount
    const reseedCounts = () => {
      notificationsApi.unreadCount().then(setUnreadN).catch(() => undefined);
      messagesApi.unreadCount().then(setUnreadC).catch(() => undefined);
    };
    reseedCounts();

    // Reseed on tab focus — local increments may have drifted while idle.
    const onFocus = () => reseedCounts();
    window.addEventListener('focus', onFocus);

    return () => {
      const s = getSocket();
      s?.off('connect', onConnect);
      s?.off('disconnect', onDisconnect);
      s?.off('notification', onNotification);
      s?.off('notification:read', onNotificationRead);
      s?.off('message', onMessage);
      s?.off('message:read', onMessageRead);
      s?.off('conversation:update', onConversationUpdate);
      s?.off('post:new', onPostNew);
      window.removeEventListener('focus', onFocus);
    };
  }, [user, qc, setConnected, setUnreadN, setUnreadC, incUnreadN, incUnreadC, incNewFeed, resetNewFeed]);

  return null;
}

/** Same verbs the notifications page uses, so a toast and its row read alike. */
function summarizeNotification(n: NotificationDTO): string {
  const name = n.actor.displayName || n.actor.username;
  switch (n.type) {
    case 'like':
      return `${name} ${i18n.t(n.comment ? 'notifications.likedComment' : 'notifications.likedPost')}`;
    case 'comment':
      return `${name} ${i18n.t('notifications.commentedOn')}`;
    case 'reply':
      return `${name} ${i18n.t('notifications.replied')}`;
    case 'follow':
      return `${name} ${i18n.t('notifications.followed')}`;
    case 'mention':
      return `${name} ${i18n.t('notifications.mentioned')}`;
    case 'message':
      return `${name} ${i18n.t('notifications.messagedYou')}`;
    default:
      return `${name}`;
  }
}

function preview(text: string): string {
  return text.length > 80 ? `${text.slice(0, 80).trimEnd()}…` : text;
}

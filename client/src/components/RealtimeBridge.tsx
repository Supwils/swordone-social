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
import * as authApi from '@/api/auth.api';
import { connectRealtime, disconnectRealtime, getSocket } from '@/api/realtime';
import { notificationVerb } from '@/lib/notificationVerb';
import type { NotificationDTO, MessageDTO, Paginated } from '@/api/types';

/**
 * A server-initiated disconnect (`io server disconnect`) is the one reason
 * Socket.IO does not retry by itself. The server sends it when a session's
 * sockets are dropped: on logout only that session's, on a password change
 * all of them — and the tab that changed the password got a regenerated
 * session, so it should come back. Each reconnect is gated on `/auth/me`
 * still answering for this user, and bounded so a session the server keeps
 * refusing cannot loop.
 */
const SERVER_KICK_WINDOW_MS = 60_000;
const MAX_SERVER_KICK_RECONNECTS = 3;

/**
 * Connects the socket once we know who the user is, subscribes to events,
 * and bridges them into TanStack Query cache + Zustand unread counts.
 */
export function RealtimeBridge() {
  // The id, not the user object: every profile save replaces the object, and
  // depending on it tore down and re-registered every socket handler.
  const userId = useSession((s) => s.user?.id ?? null);
  const setConnected = useRealtime((s) => s.setConnected);
  const setUnreadN = useRealtime((s) => s.setUnreadNotifications);
  const incUnreadN = useRealtime((s) => s.incUnreadNotifications);
  const setUnreadC = useRealtime((s) => s.setUnreadConversations);
  const incUnreadC = useRealtime((s) => s.incUnreadConversations);
  const incNewFeed = useRealtime((s) => s.incNewFeedPostCount);
  const resetNewFeed = useRealtime((s) => s.resetNewFeedPostCount);
  const qc = useQueryClient();

  useEffect(() => {
    if (!userId) {
      disconnectRealtime();
      setConnected(false);
      setUnreadN(0);
      setUnreadC(0);
      resetNewFeed();
      return;
    }

    const socket = connectRealtime();
    let disposed = false;
    let kicks: number[] = [];

    const onConnect = () => setConnected(true);
    const onDisconnect = (reason?: unknown) => {
      setConnected(false);
      // Every other reason is retried by Socket.IO's own reconnection.
      if (reason !== 'io server disconnect') return;
      if (useSession.getState().user?.id !== userId) return;
      const now = Date.now();
      kicks = kicks.filter((at) => now - at < SERVER_KICK_WINDOW_MS);
      if (kicks.length >= MAX_SERVER_KICK_RECONNECTS) return;
      kicks.push(now);
      authApi
        .me()
        .then((me) => {
          // Gone (me is null → the 401 path ends the session) or switched.
          if (disposed || !me || me.id !== userId) return;
          if (useSession.getState().user?.id !== userId) return;
          socket.connect();
        })
        .catch(() => undefined);
    };

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
      notificationsApi
        .unreadCount()
        .then(setUnreadN)
        .catch(() => undefined);
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
      if (payload.sender.id !== userId && !onThisThread) {
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
      messagesApi
        .unreadCount()
        .then(setUnreadC)
        .catch(() => undefined);
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
      notificationsApi
        .unreadCount()
        .then(setUnreadN)
        .catch(() => undefined);
      messagesApi
        .unreadCount()
        .then(setUnreadC)
        .catch(() => undefined);
    };
    reseedCounts();

    // Reseed on tab focus — local increments may have drifted while idle.
    const onFocus = () => reseedCounts();
    window.addEventListener('focus', onFocus);

    return () => {
      disposed = true;
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
  }, [
    userId,
    qc,
    setConnected,
    setUnreadN,
    setUnreadC,
    incUnreadN,
    incUnreadC,
    incNewFeed,
    resetNewFeed,
  ]);

  return null;
}

/** The notifications page's own verbs, so a toast and its row read alike. */
function summarizeNotification(n: NotificationDTO): string {
  const name = n.actor.displayName || n.actor.username;
  return `${name} ${notificationVerb(n, (key) => i18n.t(key))}`;
}

function preview(text: string): string {
  return text.length > 80 ? `${text.slice(0, 80).trimEnd()}…` : text;
}

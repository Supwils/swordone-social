import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import clsx from 'clsx';
import { ArrowLeft } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import * as messagesApi from '@/api/messages.api';
import { qk } from '@/api/queryKeys';
import { prependMessage } from '@/lib/messageCache';
import { useSession } from '@/stores/session.store';
import { Avatar, Spinner } from '@/components/primitives';
import { emit, emitTyping, emitTypingEnd, on, onConnect } from '@/api/realtime';
import { useRealtime } from '@/stores/realtime.store';
import { formatRelative } from '@/lib/formatDate';
import type { ApiError, MessageDTO, Paginated } from '@/api/types';
import s from './messages.module.css';
import { usePageTitle } from '@/lib/usePageTitle';

export default function ConversationRoute() {
  const { t } = useTranslation();
  usePageTitle(t('messages.title'));
  const { id = '' } = useParams<{ id: string }>();
  const me = useSession((st) => st.user);
  const nav = useNavigate();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [typingUserId, setTypingUserId] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef = useRef(false);
  const setUnreadC = useRealtime((s) => s.setUnreadConversations);

  // Join/leave conversation room, clear typing timer on unmount
  useEffect(() => {
    if (!id) return;
    const join = () => emit('conversation:join', { conversationId: id });
    join();
    // Re-join on every reconnect. A reconnect is a NEW server-side socket,
    // auto-joined only to `user:<id>`, and `message` / `message:read` /
    // `typing` are all conversation-room-scoped — so without this an open
    // thread silently stops updating after a sleep, a wifi blip or an API
    // redeploy, and only navigating away and back brings it back.
    const offConnect = onConnect(join);
    return () => {
      offConnect();
      emit('conversation:leave', { conversationId: id });
      if (typingTimerRef.current) {
        clearTimeout(typingTimerRef.current);
        if (isTypingRef.current) emitTypingEnd(id);
      }
    };
  }, [id]);

  // Mark read on enter and decrement nav badge
  useEffect(() => {
    if (!id) return;
    messagesApi
      .markRead(id)
      .then(() => messagesApi.unreadCount())
      .then(setUnreadC)
      .catch(() => undefined);
  }, [id, setUnreadC]);

  // Fetch conversation metadata (participants) — fixes blank header on new convos
  const convo = useQuery({
    queryKey: qk.conversations.byId(id),
    queryFn: () => messagesApi.getConversation(id),
    enabled: Boolean(id),
    staleTime: 60_000,
  });

  const q = useInfiniteQuery({
    queryKey: qk.conversations.messages(id),
    queryFn: ({ pageParam }) => messagesApi.listMessages(id, { cursor: pageParam, limit: 50 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: Boolean(id),
  });

  // Realtime: RealtimeBridge (global) handles cache updates and toast for all conversations.
  // Here we only need to mark the conversation as read when messages arrive while viewing it.
  useEffect(() => {
    if (!id) return;
    return on('message', (payload) => {
      const msg = payload as MessageDTO;
      if (msg.conversationId !== id) return;
      if (msg.sender.id === me?.id) return;
      // Clear typing indicator when a message arrives
      setTypingUserId(null);
      messagesApi
        .markRead(id)
        .then(() => messagesApi.unreadCount())
        .then(setUnreadC)
        .catch(() => undefined);
    });
  }, [id, me?.id, setUnreadC]);

  // Typing indicator listeners
  useEffect(() => {
    if (!id) return;
    const offTyping = on('typing', (payload) => {
      const { userId: uid } = payload as { userId: string };
      setTypingUserId(uid);
    });
    const offTypingEnd = on('typing:end', (payload) => {
      const { userId: uid } = payload as { userId: string };
      setTypingUserId((prev) => (prev === uid ? null : prev));
    });
    return () => {
      offTyping();
      offTypingEnd();
    };
  }, [id]);

  const send = useMutation({
    mutationFn: () => messagesApi.send(id, text.trim()),
    onSuccess: (msg) => {
      setText('');
      // Reset textarea height
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
      // Prepend to cache. `prependMessage` dedupes: the socket frame for our
      // own message normally lands before this 201 does.
      qc.setQueryData(
        qk.conversations.messages(id),
        (old: InfiniteData<Paginated<MessageDTO>> | undefined) => {
          if (!old) {
            return { pages: [{ items: [msg], nextCursor: null }], pageParams: [null] };
          }
          return prependMessage(old, msg);
        },
      );
    },
    onError: (err) => toast.error((err as unknown as ApiError).message),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || send.isPending) return;
    send.mutate();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit(e as unknown as FormEvent);
    }
  };

  // Auto-resize textarea as user types
  const autoResize = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, []);

  const onTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    autoResize(e.target);

    // Typing indicator: emit once per burst, clear after 2s of inactivity
    if (!isTypingRef.current) {
      isTypingRef.current = true;
      emitTyping(id);
    }
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      isTypingRef.current = false;
      emitTypingEnd(id);
    }, 2000);
  };

  const messages = q.data?.pages.flatMap((p) => p.items) ?? [];

  // Derive the other participant from conversation metadata (reliable) or messages (fallback)
  const other =
    convo.data?.participants.find((p) => p.id !== me?.id) ??
    convo.data?.participants[0] ??
    messages.find((m) => m.sender.id !== me?.id)?.sender ??
    null;

  if (!id) {
    nav('/messages');
    return null;
  }

  return (
    <div className={s.thread}>
      <header className={s.threadHeader}>
        <Link to="/messages" className={s.backLink}>
          <ArrowLeft size={14} weight="regular" aria-hidden /> {t('messages.back')}
        </Link>
        {other && (
          <Link to={`/u/${other.username}`} className={s.threadPeer}>
            <Avatar
              src={other.avatarUrl}
              name={other.displayName || other.username}
              size="sm"
              alt=""
            />
            <strong>{other.displayName || other.username}</strong>
            <span className={s.rowDate}>@{other.username}</span>
          </Link>
        )}
        {!other && convo.isLoading && <Spinner />}
      </header>

      <div className={s.threadBody} ref={bodyRef}>
        {q.isLoading && <Spinner />}
        {q.hasNextPage && (
          <div className={s.loadOlder}>
            <button
              type="button"
              className={s.loadOlderBtn}
              onClick={() => q.fetchNextPage()}
              disabled={q.isFetchingNextPage}
            >
              {q.isFetchingNextPage ? <Spinner /> : t('messages.loadOlder')}
            </button>
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} m={m} mine={m.sender.id === me?.id} />
        ))}
      </div>

      {typingUserId && other && typingUserId !== me?.id && (
        <div className={s.typingIndicator}>
          <span className={s.typingName}>{other.displayName || other.username}</span>{' '}
          {t('messages.isTyping')}
          <span className={s.typingDots}>
            <span />
            <span />
            <span />
          </span>
        </div>
      )}

      <form onSubmit={onSubmit} className={s.composeRow}>
        <textarea
          ref={textareaRef}
          className={s.composeInput}
          value={text}
          onChange={onTextChange}
          onKeyDown={onKeyDown}
          placeholder={t('messages.messagePlaceholder')}
          maxLength={4000}
          rows={1}
          aria-label="Your message"
        />
        <button
          type="submit"
          className={s.sendBtn}
          disabled={send.isPending || !text.trim()}
          aria-label={t('messages.send')}
        >
          {send.isPending ? <Spinner /> : t('messages.send')}
        </button>
      </form>
    </div>
  );
}

function MessageBubble({ m, mine }: { m: MessageDTO; mine: boolean }) {
  return (
    <div className={clsx(s.bubbleWrap, mine && s.bubbleWrapMine)}>
      <div className={clsx(s.message, mine && s.messageMine)}>{m.text}</div>
      <time dateTime={m.createdAt} className={clsx(s.messageMeta, mine && s.messageMetaMine)}>
        {formatRelative(m.createdAt)}
      </time>
    </div>
  );
}

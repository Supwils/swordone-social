import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSession } from '@/stores/session.store';
import { useRealtime } from '@/stores/realtime.store';
import { qk } from '@/api/queryKeys';
import type { MessageDTO, NotificationDTO, Paginated, UserDTO, UserLiteDTO } from '@/api/types';

/**
 * The socket is faked at the module boundary: handlers are captured in a map
 * and each test fires them directly. Everything downstream is real — the
 * TanStack Query cache, the Zustand stores, the dedupe in messageCache — so
 * these tests pin the bridge's *effects*, not its wiring.
 */
const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (payload?: unknown) => void>();
  const socket = {
    on: vi.fn((event: string, fn: (payload?: unknown) => void) => {
      handlers.set(event, fn);
    }),
    off: vi.fn((event: string) => {
      handlers.delete(event);
    }),
  };
  return {
    handlers,
    socket,
    connectRealtime: vi.fn(() => socket),
    disconnectRealtime: vi.fn(),
    getSocket: vi.fn(() => socket),
    notifUnread: vi.fn(() => Promise.resolve(5)),
    msgUnread: vi.fn(() => Promise.resolve(2)),
    toast: vi.fn(),
  };
});

vi.mock('@/api/realtime', () => ({
  connectRealtime: mocks.connectRealtime,
  disconnectRealtime: mocks.disconnectRealtime,
  getSocket: mocks.getSocket,
}));
vi.mock('@/api/notifications.api', () => ({ unreadCount: mocks.notifUnread }));
vi.mock('@/api/messages.api', () => ({ unreadCount: mocks.msgUnread }));
vi.mock('sonner', () => ({ toast: mocks.toast }));

import { RealtimeBridge } from './RealtimeBridge';

function makeUser(id: string): UserDTO {
  return {
    id,
    username: `u-${id}`,
    usernameDisplay: `u-${id}`,
    displayName: `User ${id}`,
    bio: '',
    headline: '',
    avatarUrl: null,
    coverUrl: null,
    location: null,
    website: null,
    profileTags: [],
    isAgent: false,
    followerCount: 0,
    followingCount: 0,
    postCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

const actor: UserLiteDTO = {
  id: 'u-actor',
  username: 'alice',
  usernameDisplay: 'alice',
  displayName: 'Alice',
  avatarUrl: null,
  headline: '',
  profileTags: [],
  isAgent: false,
};

function makeNotification(id: string, over: Partial<NotificationDTO> = {}): NotificationDTO {
  return { id, type: 'like', actor, read: false, createdAt: '2026-01-02T00:00:00.000Z', ...over };
}

function makeMessage(id: string, over: Partial<MessageDTO> = {}): MessageDTO {
  return {
    id,
    conversationId: 'c-1',
    sender: actor,
    text: 'hi',
    readBy: [],
    createdAt: '2026-01-02T00:00:00.000Z',
    ...over,
  };
}

type Pages<T> = { pages: Paginated<T>[]; pageParams: unknown[] };

function pagesOf<T>(items: T[]): Pages<T> {
  return { pages: [{ items, nextCursor: null }], pageParams: [null] };
}

function renderBridge() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <RealtimeBridge />
    </QueryClientProvider>,
  );
  return { qc, ...view };
}

/** Render, then wait for the mount-time unread reseed so later assertions
 * on counter deltas are not racing the initial seed. */
async function renderBridgeSeeded() {
  const out = renderBridge();
  await waitFor(() => {
    expect(useRealtime.getState().unreadNotifications).toBe(5);
    expect(useRealtime.getState().unreadConversations).toBe(2);
  });
  return out;
}

function fire(event: string, payload?: unknown) {
  const handler = mocks.handlers.get(event);
  expect(handler, `no handler registered for "${event}"`).toBeTypeOf('function');
  act(() => handler?.(payload));
}

beforeEach(() => {
  useSession.setState({ user: makeUser('me'), bootstrap: 'ready' });
  useRealtime.setState({
    connected: false,
    unreadNotifications: 0,
    unreadConversations: 0,
    newFeedPostCount: 0,
  });
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.handlers.clear();
  mocks.notifUnread.mockImplementation(() => Promise.resolve(5));
  mocks.msgUnread.mockImplementation(() => Promise.resolve(2));
});

describe('RealtimeBridge lifecycle', () => {
  it('connects when a user is present, registers handlers, and seeds unread counts', async () => {
    await renderBridgeSeeded();

    expect(mocks.connectRealtime).toHaveBeenCalledOnce();
    for (const event of [
      'connect',
      'disconnect',
      'notification',
      'notification:read',
      'message',
      'message:read',
      'conversation:update',
      'post:new',
    ]) {
      expect(mocks.handlers.has(event), `handler for "${event}"`).toBe(true);
    }
  });

  it('tracks socket connection state', async () => {
    await renderBridgeSeeded();
    fire('connect');
    expect(useRealtime.getState().connected).toBe(true);
    fire('disconnect');
    expect(useRealtime.getState().connected).toBe(false);
  });

  it('disconnects and zeroes all counters when the user logs out', async () => {
    await renderBridgeSeeded();
    act(() => useRealtime.setState({ newFeedPostCount: 3 }));

    act(() => useSession.setState({ user: null }));

    expect(mocks.disconnectRealtime).toHaveBeenCalled();
    const s = useRealtime.getState();
    expect(s.connected).toBe(false);
    expect(s.unreadNotifications).toBe(0);
    expect(s.unreadConversations).toBe(0);
    expect(s.newFeedPostCount).toBe(0);
  });

  it('reseeds unread counts on window focus', async () => {
    await renderBridgeSeeded();
    mocks.notifUnread.mockImplementation(() => Promise.resolve(9));
    mocks.msgUnread.mockImplementation(() => Promise.resolve(4));

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => {
      expect(useRealtime.getState().unreadNotifications).toBe(9);
      expect(useRealtime.getState().unreadConversations).toBe(4);
    });
  });
});

describe('RealtimeBridge notifications', () => {
  it('upserts into the cached list, bumps unread, and toasts', async () => {
    const { qc } = await renderBridgeSeeded();
    const n1 = makeNotification('n-1');
    qc.setQueryData(qk.notifications.list, pagesOf([n1]));

    const n2 = makeNotification('n-2', { type: 'follow' });
    fire('notification', n2);

    const cached = qc.getQueryData<Pages<NotificationDTO>>(qk.notifications.list);
    expect(cached?.pages[0].items.map((n) => n.id)).toEqual(['n-2', 'n-1']);
    expect(useRealtime.getState().unreadNotifications).toBe(6);
    expect(mocks.toast).toHaveBeenCalledWith('Alice started following you');
  });

  it('dedupes a redelivered notification instead of listing it twice', async () => {
    const { qc } = await renderBridgeSeeded();
    const n1 = makeNotification('n-1');
    qc.setQueryData(qk.notifications.list, pagesOf([n1]));

    fire('notification', n1);

    const cached = qc.getQueryData<Pages<NotificationDTO>>(qk.notifications.list);
    expect(cached?.pages[0].items.map((n) => n.id)).toEqual(['n-1']);
  });

  it('does not materialise a list cache that does not exist yet', async () => {
    const { qc } = await renderBridgeSeeded();
    fire('notification', makeNotification('n-1'));
    expect(qc.getQueryData(qk.notifications.list)).toBeUndefined();
  });

  it('summarizes each notification type for the toast', async () => {
    await renderBridgeSeeded();

    fire('notification', makeNotification('n-1', { type: 'like' }));
    fire(
      'notification',
      makeNotification('n-2', { type: 'like', comment: { id: 'c', textPreview: '' } }),
    );
    fire('notification', makeNotification('n-3', { type: 'comment' }));
    fire('notification', makeNotification('n-4', { type: 'reply' }));
    fire('notification', makeNotification('n-5', { type: 'mention' }));
    fire('notification', makeNotification('n-6', { type: 'message' }));

    expect(mocks.toast.mock.calls.map((c) => c[0])).toEqual([
      'Alice liked your post',
      'Alice liked your comment',
      'Alice commented on your post',
      'Alice replied to your comment',
      'Alice mentioned you',
      'Alice sent you a message',
    ]);
  });

  it('notification:read invalidates the list and reseeds the authoritative count', async () => {
    const { qc } = await renderBridgeSeeded();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    mocks.notifUnread.mockImplementation(() => Promise.resolve(0));

    fire('notification:read', { ids: 'all' });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.notifications.list });
    await waitFor(() => expect(useRealtime.getState().unreadNotifications).toBe(0));
  });
});

describe('RealtimeBridge messages', () => {
  it('prepends an incoming message, bumps unread, and toasts when off-thread', async () => {
    const { qc } = await renderBridgeSeeded();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const m1 = makeMessage('m-1');
    qc.setQueryData(qk.conversations.messages('c-1'), pagesOf([m1]));

    fire('message', makeMessage('m-2', { text: 'hello there' }));

    const cached = qc.getQueryData<Pages<MessageDTO>>(qk.conversations.messages('c-1'));
    expect(cached?.pages[0].items.map((m) => m.id)).toEqual(['m-2', 'm-1']);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.conversations.list });
    expect(useRealtime.getState().unreadConversations).toBe(3);
    expect(mocks.toast).toHaveBeenCalledWith('@alice: hello there');
  });

  it('does not toast or bump unread when already viewing the conversation', async () => {
    const { qc } = await renderBridgeSeeded();
    window.history.replaceState(null, '', '/messages/c-1');
    qc.setQueryData(qk.conversations.messages('c-1'), pagesOf([makeMessage('m-1')]));

    fire('message', makeMessage('m-2'));

    const cached = qc.getQueryData<Pages<MessageDTO>>(qk.conversations.messages('c-1'));
    expect(cached?.pages[0].items).toHaveLength(2);
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(useRealtime.getState().unreadConversations).toBe(2);
  });

  it("does not toast the sender's own socket echo", async () => {
    const { qc } = await renderBridgeSeeded();
    qc.setQueryData(qk.conversations.messages('c-1'), pagesOf([]));

    fire('message', makeMessage('m-2', { sender: { ...actor, id: 'me' } }));

    const cached = qc.getQueryData<Pages<MessageDTO>>(qk.conversations.messages('c-1'));
    expect(cached?.pages[0].items.map((m) => m.id)).toEqual(['m-2']);
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(useRealtime.getState().unreadConversations).toBe(2);
  });

  it('does not materialise a thread cache nobody is looking at', async () => {
    const { qc } = await renderBridgeSeeded();
    fire('message', makeMessage('m-1', { conversationId: 'c-quiet' }));
    expect(qc.getQueryData(qk.conversations.messages('c-quiet'))).toBeUndefined();
  });

  it('message:read merges the reader into readBy exactly once', async () => {
    const { qc } = await renderBridgeSeeded();
    qc.setQueryData(
      qk.conversations.messages('c-1'),
      pagesOf([makeMessage('m-1'), makeMessage('m-2', { readBy: ['u-2'] })]),
    );

    fire('message:read', { conversationId: 'c-1', userId: 'u-2' });
    fire('message:read', { conversationId: 'c-1', userId: 'u-2' });

    const cached = qc.getQueryData<Pages<MessageDTO>>(qk.conversations.messages('c-1'));
    expect(cached?.pages[0].items.map((m) => m.readBy)).toEqual([['u-2'], ['u-2']]);
  });

  it('conversation:update invalidates the list and reseeds conversation unread', async () => {
    const { qc } = await renderBridgeSeeded();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    mocks.msgUnread.mockImplementation(() => Promise.resolve(7));

    fire('conversation:update');

    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.conversations.list });
    await waitFor(() => expect(useRealtime.getState().unreadConversations).toBe(7));
  });

  it('post:new increments the new-feed counter', async () => {
    await renderBridgeSeeded();
    fire('post:new');
    fire('post:new');
    expect(useRealtime.getState().newFeedPostCount).toBe(2);
  });
});

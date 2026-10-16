import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '@/i18n';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (payload: unknown) => void>();
  return {
    handlers,
    emit: vi.fn(),
    onConnect: vi.fn((_listener: () => void) => () => undefined),
    on: vi.fn((event: string, fn: (payload: unknown) => void) => {
      handlers.set(event, fn);
      return () => {
        if (handlers.get(event) === fn) handlers.delete(event);
      };
    }),
    getConversation: vi.fn((_id: string): Promise<unknown> => new Promise(() => undefined)),
    listMessages: vi.fn(() => new Promise(() => undefined)),
    markRead: vi.fn((_id: string) => Promise.resolve()),
  };
});

vi.mock('@/api/realtime', () => ({
  emit: mocks.emit,
  emitTyping: vi.fn(),
  emitTypingEnd: vi.fn(),
  on: mocks.on,
  onConnect: mocks.onConnect,
}));

vi.mock('@/api/messages.api', () => ({
  getConversation: mocks.getConversation,
  listMessages: mocks.listMessages,
  markRead: mocks.markRead,
  unreadCount: vi.fn(() => Promise.resolve(0)),
  send: vi.fn(),
}));

import ConversationRoute from './conversation';
import { useSession } from '@/stores/session.store';
import { makeUser, makeUserLite } from '@/test/fixtures';

/** Conversation ids are ObjectIds; the route refuses anything else. */
const CID = '64b7f0c2a1d3e4f5a6b7c8d9';

function renderConversation(path = `/messages/${CID}`) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/messages/:id" element={<ConversationRoute />} />
          <Route path="/messages" element={<div>INBOX</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.handlers.clear();
  useSession.setState({ user: null });
});

describe('ConversationRoute room membership', () => {
  it('re-joins the conversation room after a socket reconnect', async () => {
    // A reconnect is a NEW server-side socket, and the handshake auto-joins
    // only `user:<id>`. `message`, `message:read` and `typing` are all
    // conversation-room-scoped, so without a re-join an open thread silently
    // stops updating after any sleep, wifi blip, or API redeploy — until the
    // user navigates away and back.
    renderConversation();

    await waitFor(() =>
      expect(mocks.emit).toHaveBeenCalledWith('conversation:join', { conversationId: CID }),
    );
    expect(mocks.onConnect).toHaveBeenCalledOnce();

    mocks.emit.mockClear();
    const onReconnect = mocks.onConnect.mock.calls[0]?.[0];
    expect(onReconnect).toBeTypeOf('function');
    onReconnect?.();

    expect(mocks.emit).toHaveBeenCalledWith('conversation:join', { conversationId: CID });
  });

  it('stops re-joining once the thread is closed', async () => {
    const unsubscribe = vi.fn();
    mocks.onConnect.mockReturnValueOnce(unsubscribe);

    const { unmount } = renderConversation();
    await waitFor(() => expect(mocks.onConnect).toHaveBeenCalledOnce());
    unmount();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(mocks.emit).toHaveBeenCalledWith('conversation:leave', { conversationId: CID });
  });
});

describe('ConversationRoute id validation', () => {
  it('makes no request and no emit for an id that is not an ObjectId', async () => {
    // React Router decodes %2F: this path hands the route `../users/x/follow?`.
    // The mount-time markRead used to POST /conversations/../users/x/follow?/read
    // — i.e. follow `x` with the viewer's cookie, zero click.
    renderConversation(`/messages/${encodeURIComponent('../users/x/follow?')}`);

    expect(await screen.findByText('INBOX')).toBeTruthy();
    expect(mocks.markRead).not.toHaveBeenCalled();
    expect(mocks.getConversation).not.toHaveBeenCalled();
    expect(mocks.listMessages).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('marks a well-formed thread read on entry', async () => {
    renderConversation();
    await waitFor(() => expect(mocks.markRead).toHaveBeenCalledWith(CID));
  });
});

describe('ConversationRoute typing indicator', () => {
  it('expires a typing indicator whose typing:end never arrives', async () => {
    const me = makeUser({ id: 'me', username: 'me' });
    const peer = makeUserLite({ id: 'peer', username: 'peer', displayName: 'Peer' });
    useSession.setState({ user: me });
    mocks.getConversation.mockResolvedValueOnce({ id: CID, participants: [me, peer] });

    renderConversation();
    await screen.findByText('Peer');
    vi.useFakeTimers();

    act(() => mocks.handlers.get('typing')?.({ userId: 'peer' }));
    expect(screen.getByText(/is typing/)).toBeTruthy();

    act(() => vi.advanceTimersByTime(4900));
    expect(screen.queryByText(/is typing/)).toBeTruthy();

    // A second frame re-arms the expiry.
    act(() => mocks.handlers.get('typing')?.({ userId: 'peer' }));
    act(() => vi.advanceTimersByTime(4900));
    expect(screen.queryByText(/is typing/)).toBeTruthy();

    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByText(/is typing/)).toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '@/i18n';

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  onConnect: vi.fn((_listener: () => void) => () => undefined),
}));

vi.mock('@/api/realtime', () => ({
  emit: mocks.emit,
  emitTyping: vi.fn(),
  emitTypingEnd: vi.fn(),
  on: vi.fn(() => () => undefined),
  onConnect: mocks.onConnect,
}));

vi.mock('@/api/messages.api', () => ({
  getConversation: vi.fn(() => new Promise(() => undefined)),
  listMessages: vi.fn(() => new Promise(() => undefined)),
  markRead: vi.fn(() => Promise.resolve()),
  unreadCount: vi.fn(() => Promise.resolve(0)),
  send: vi.fn(),
}));

import ConversationRoute from './conversation';

function renderConversation() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/messages/c-1']}>
        <Routes>
          <Route path="/messages/:id" element={<ConversationRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
      expect(mocks.emit).toHaveBeenCalledWith('conversation:join', { conversationId: 'c-1' }),
    );
    expect(mocks.onConnect).toHaveBeenCalledOnce();

    mocks.emit.mockClear();
    const onReconnect = mocks.onConnect.mock.calls[0]?.[0];
    expect(onReconnect).toBeTypeOf('function');
    onReconnect?.();

    expect(mocks.emit).toHaveBeenCalledWith('conversation:join', { conversationId: 'c-1' });
  });

  it('stops re-joining once the thread is closed', async () => {
    const unsubscribe = vi.fn();
    mocks.onConnect.mockReturnValueOnce(unsubscribe);

    const { unmount } = renderConversation();
    await waitFor(() => expect(mocks.onConnect).toHaveBeenCalledOnce());
    unmount();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(mocks.emit).toHaveBeenCalledWith('conversation:leave', { conversationId: 'c-1' });
  });
});

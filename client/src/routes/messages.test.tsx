import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '@/i18n';
import { useSession } from '@/stores/session.store';
import type { ConversationDTO, MessageDTO, UserDTO, UserLiteDTO } from '@/api/types';

const mocks = vi.hoisted(() => ({
  listConversations: vi.fn(),
  findOrCreate: vi.fn(),
  searchUsers: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@/api/messages.api', () => ({
  listConversations: mocks.listConversations,
  findOrCreate: mocks.findOrCreate,
}));
vi.mock('@/api/users.api', () => ({ searchUsers: mocks.searchUsers }));
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));
vi.mock('@/components/InfiniteScrollSentinel', () => ({
  InfiniteScrollSentinel: () => null,
}));

import MessagesRoute from './messages';

function lite(id: string, name: string): UserLiteDTO {
  return {
    id,
    username: name.toLowerCase(),
    usernameDisplay: name.toLowerCase(),
    displayName: name,
    avatarUrl: null,
    headline: '',
    profileTags: [],
    isAgent: false,
  };
}

const meLite = lite('u-me', 'Me');
const other = lite('u-o', 'Other');

function makeConvo(over: Partial<ConversationDTO> = {}): ConversationDTO {
  return {
    id: 'c-1',
    participants: [meLite, other],
    lastMessage: {
      id: 'm-1',
      conversationId: 'c-1',
      sender: other,
      text: 'hey there',
      readBy: [],
      createdAt: '2026-01-01T00:00:00.000Z',
    } as MessageDTO,
    unread: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function renderRoute() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/messages']}>
        <Routes>
          <Route path="/messages" element={<MessagesRoute />} />
          <Route path="/messages/:id" element={<div>CONVERSATION-DEST</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useSession.setState({ user: { id: 'u-me' } as UserDTO, bootstrap: 'ready' });
  mocks.listConversations.mockResolvedValue({ items: [], nextCursor: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MessagesRoute', () => {
  it('lists conversations with the other participant and their last message', async () => {
    mocks.listConversations.mockResolvedValue({
      items: [
        makeConvo(),
        makeConvo({
          id: 'c-2',
          lastMessage: {
            id: 'm-2',
            conversationId: 'c-2',
            sender: meLite,
            text: 'hi back',
            readBy: [],
            createdAt: '2026-01-02T00:00:00.000Z',
          } as MessageDTO,
        }),
        makeConvo({ id: 'c-3', lastMessage: null }),
      ],
      nextCursor: null,
    });

    renderRoute();

    // Rows always show the OTHER participant, never the viewer.
    expect(await screen.findAllByText('Other')).toHaveLength(3);
    expect(screen.queryByText('Me')).toBeNull();
    expect(screen.getByText('hey there')).toBeTruthy();
    // Own messages are prefixed, so the viewer can tell who spoke last.
    expect(screen.getByText('You: hi back')).toBeTruthy();
    // A conversation with no messages yet gets the placeholder.
    expect(screen.getByText('No messages yet — say something.')).toBeTruthy();
    expect(mocks.listConversations).toHaveBeenCalledWith({ cursor: null, limit: 30 });
  });

  it('shows the empty state when there are no conversations', async () => {
    renderRoute();

    expect(await screen.findByText('No conversations yet.')).toBeTruthy();
  });

  it('searches users and opens the picked conversation', async () => {
    mocks.searchUsers.mockResolvedValue([other]);
    mocks.findOrCreate.mockResolvedValue(makeConvo({ id: 'c-9' }));

    renderRoute();

    const input = screen.getByLabelText('Search users');
    fireEvent.change(input, { target: { value: 'oth' } });

    await waitFor(() => expect(mocks.searchUsers).toHaveBeenCalled());
    expect(mocks.searchUsers.mock.calls[0][0]).toBe('oth');

    const option = await screen.findByRole('option');
    // The dropdown picks on mousedown (before blur), not click.
    fireEvent.mouseDown(option.querySelector('button') as HTMLElement);

    await waitFor(() => expect(mocks.findOrCreate).toHaveBeenCalledWith('other'));
    expect(await screen.findByText('CONVERSATION-DEST')).toBeTruthy();
  });

  it('shows the no-users hint for a search without matches', async () => {
    mocks.searchUsers.mockResolvedValue([]);

    renderRoute();

    fireEvent.change(screen.getByLabelText('Search users'), { target: { value: 'zzz' } });

    expect(await screen.findByText('No users found')).toBeTruthy();
    expect(mocks.findOrCreate).not.toHaveBeenCalled();
  });
});

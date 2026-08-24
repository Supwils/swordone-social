import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import '@/i18n';
import type { UserLiteDTO } from '@/api/types';

const mocks = vi.hoisted(() => ({
  listFollowers: vi.fn(),
  listFollowing: vi.fn(),
}));

vi.mock('@/api/follows.api', () => ({
  checkFollowing: vi.fn(),
  follow: vi.fn(),
  unfollow: vi.fn(),
  listFollowers: mocks.listFollowers,
  listFollowing: mocks.listFollowing,
}));
vi.mock('@/components/InfiniteScrollSentinel', () => ({
  InfiniteScrollSentinel: () => null,
}));

import { FollowListModal } from './FollowListModal';

function makeUser(over: Partial<UserLiteDTO> = {}): UserLiteDTO {
  return {
    id: 'u-alice',
    username: 'alice',
    usernameDisplay: 'alice',
    displayName: 'Alice A',
    avatarUrl: null,
    headline: '',
    profileTags: [],
    isAgent: false,
    ...over,
  };
}

function renderModal(type: 'followers' | 'following' = 'followers') {
  const onClose = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <FollowListModal username="bob" type={type} open onClose={onClose} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return onClose;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FollowListModal', () => {
  it('lists the followers of the given username in a dialog', async () => {
    mocks.listFollowers.mockResolvedValue({
      items: [makeUser(), makeUser({ id: 'u-agent', username: 'zenith', displayName: 'Zenith', isAgent: true })],
      nextCursor: null,
    });

    renderModal('followers');

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Followers')).toBeTruthy();
    expect(await screen.findByText('Alice A')).toBeTruthy();
    expect(screen.getByText('@alice')).toBeTruthy();
    // agent accounts carry the AI badge
    expect(screen.getByText('AI')).toBeTruthy();
    expect(mocks.listFollowers).toHaveBeenCalledWith(
      'bob',
      { cursor: null, limit: 40, search: undefined },
      expect.anything(),
    );
    expect(mocks.listFollowing).not.toHaveBeenCalled();
  });

  it('lists following via the following endpoint with its own title', async () => {
    mocks.listFollowing.mockResolvedValue({ items: [makeUser()], nextCursor: null });

    renderModal('following');

    expect(screen.getByText('Following')).toBeTruthy();
    expect(await screen.findByText('Alice A')).toBeTruthy();
    expect(mocks.listFollowing).toHaveBeenCalledWith(
      'bob',
      { cursor: null, limit: 40, search: undefined },
      expect.anything(),
    );
    expect(mocks.listFollowers).not.toHaveBeenCalled();
  });

  it('shows the per-type empty states', async () => {
    mocks.listFollowers.mockResolvedValue({ items: [], nextCursor: null });
    renderModal('followers');
    expect(await screen.findByText('No followers yet.')).toBeTruthy();
    cleanup();

    mocks.listFollowing.mockResolvedValue({ items: [], nextCursor: null });
    renderModal('following');
    expect(await screen.findByText('Not following anyone yet.')).toBeTruthy();
  });

  it('debounces the search box into the list query and shows the no-match state', async () => {
    mocks.listFollowers.mockResolvedValue({ items: [makeUser()], nextCursor: null });
    renderModal('followers');
    await screen.findByText('Alice A');

    mocks.listFollowers.mockResolvedValue({ items: [], nextCursor: null });
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'ghost' } });

    await waitFor(() =>
      expect(mocks.listFollowers).toHaveBeenCalledWith(
        'bob',
        { cursor: null, limit: 40, search: 'ghost' },
        expect.anything(),
      ),
    );
    expect(await screen.findByText('No one matches that.')).toBeTruthy();
  });

  it('closes when a user row is clicked', async () => {
    mocks.listFollowers.mockResolvedValue({ items: [makeUser()], nextCursor: null });
    const onClose = renderModal('followers');

    fireEvent.click(await screen.findByText('Alice A'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

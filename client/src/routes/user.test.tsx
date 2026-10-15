import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '@/i18n';
import { useSession } from '@/stores/session.store';
import type { ConversationDTO, PostDTO, UserDTO } from '@/api/types';

const mocks = vi.hoisted(() => ({
  getByUsername: vi.fn(),
  byUser: vi.fn(),
  checkFollowing: vi.fn(),
  follow: vi.fn(),
  unfollow: vi.fn(),
  findOrCreate: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/api/users.api', () => ({ getByUsername: mocks.getByUsername }));
vi.mock('@/api/feed.api', () => ({ byUser: mocks.byUser }));
vi.mock('@/api/follows.api', () => ({
  checkFollowing: mocks.checkFollowing,
  follow: mocks.follow,
  unfollow: mocks.unfollow,
}));
vi.mock('@/api/messages.api', () => ({ findOrCreate: mocks.findOrCreate }));
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));
vi.mock('@/features/posts/PostCard', () => ({
  PostCard: ({ post }: { post: { text: string } }) => (
    <article data-testid="post-card">{post.text}</article>
  ),
}));
vi.mock('@/components/InfiniteScrollSentinel', () => ({
  InfiniteScrollSentinel: () => null,
}));
vi.mock('@/features/users/FollowListModal', () => ({
  FollowListModal: ({ type }: { type: string }) => <div data-testid={`modal-${type}`} />,
}));
vi.mock('@/features/lab', () => ({ AgentDriftWidget: () => null }));
vi.mock('@/features/bookmarks/BookmarksFeed', () => ({
  BookmarksFeed: () => <div data-testid="bookmarks-feed" />,
}));

import UserRoute from './user';

function makeUser(over: Partial<UserDTO> = {}): UserDTO {
  return {
    id: 'u-bob',
    username: 'bob',
    usernameDisplay: 'bob',
    displayName: 'Bob',
    bio: '',
    headline: '',
    avatarUrl: null,
    coverUrl: null,
    location: null,
    website: null,
    profileTags: [],
    isAgent: false,
    followerCount: 5,
    followingCount: 3,
    postCount: 7,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function renderAt(
  username = 'bob',
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/u/${username}`]}>
        <Routes>
          <Route path="/u/:username" element={<UserRoute />} />
          <Route path="/messages/:id" element={<div>CONVERSATION-DEST</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useSession.setState({ user: null, bootstrap: 'ready' });
  mocks.byUser.mockResolvedValue({ items: [], nextCursor: null });
  mocks.checkFollowing.mockResolvedValue(false);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('UserRoute', () => {
  it('renders the profile and its posts; anonymous viewers get no actions', async () => {
    mocks.getByUsername.mockResolvedValue(makeUser());
    mocks.byUser.mockResolvedValue({
      items: [{ id: 'p-1', text: 'a post by bob' } as PostDTO],
      nextCursor: null,
    });

    renderAt();

    expect(await screen.findByText('Bob')).toBeTruthy();
    expect(screen.getByText('@bob')).toBeTruthy();
    expect((await screen.findByTestId('post-card')).textContent).toBe('a post by bob');
    expect(mocks.byUser).toHaveBeenCalledWith('bob', { cursor: null, limit: 20 });
    // counts
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
    // signed out: no follow/message actions
    expect(screen.queryByRole('button', { name: 'Follow' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Message' })).toBeNull();
  });

  it('shows the not-found state for an unknown username', async () => {
    mocks.getByUsername.mockRejectedValue({ status: 404, message: 'User not found' });

    renderAt('ghost');

    expect(await screen.findByText('User not found')).toBeTruthy();
    expect(screen.getByText('No one on SwordOne goes by @ghost yet.')).toBeTruthy();
  });

  it('follows a user and bumps the follower count optimistically', async () => {
    useSession.setState({ user: makeUser({ id: 'u-me', username: 'me' }), bootstrap: 'ready' });
    mocks.getByUsername.mockResolvedValue(makeUser());
    mocks.follow.mockResolvedValue(undefined);

    renderAt();

    // 'Follow' is the default label while followStatus is still loading, and
    // the button is disabled until it settles — wait for enabled, then click.
    const followBtn = (await screen.findByRole('button', { name: 'Follow' })) as HTMLButtonElement;
    await waitFor(() => expect(followBtn.disabled).toBe(false));
    fireEvent.click(followBtn);

    await waitFor(() => expect(mocks.follow).toHaveBeenCalledWith('bob'));
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Following @bob');
    expect(await screen.findByText('6')).toBeTruthy();
    // cache flip: the button becomes Unfollow without a refetch
    expect(await screen.findByRole('button', { name: 'Unfollow' })).toBeTruthy();
  });

  it('invalidates the following feed and follow lists after a follow', async () => {
    // Those caches sit under a 30s staleTime; without an explicit
    // invalidation a user who followed someone and went straight back to
    // /feed kept seeing the pre-follow river.
    useSession.setState({ user: makeUser({ id: 'u-me', username: 'me' }), bootstrap: 'ready' });
    mocks.getByUsername.mockResolvedValue(makeUser());
    mocks.follow.mockResolvedValue(undefined);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const feedKey = ['feed', 'following', 'en', 'recommended'];
    const followersKey = ['users', 'bob', 'followers'];
    const myFollowingKey = ['users', 'me', 'following'];
    const unrelatedKey = ['feed', 'global', 'en', 'recommended'];
    for (const key of [feedKey, followersKey, myFollowingKey, unrelatedKey]) {
      qc.setQueryData(key, { pages: [], pageParams: [] });
    }

    renderAt('bob', qc);

    const followBtn = (await screen.findByRole('button', { name: 'Follow' })) as HTMLButtonElement;
    await waitFor(() => expect(followBtn.disabled).toBe(false));
    fireEvent.click(followBtn);

    await waitFor(() => expect(qc.getQueryState(feedKey)?.isInvalidated).toBe(true));
    expect(qc.getQueryState(followersKey)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(myFollowingKey)?.isInvalidated).toBe(true);
    // The global river does not depend on who I follow.
    expect(qc.getQueryState(unrelatedKey)?.isInvalidated).toBe(false);
  });

  it('unfollows and decrements the follower count', async () => {
    useSession.setState({ user: makeUser({ id: 'u-me', username: 'me' }), bootstrap: 'ready' });
    mocks.getByUsername.mockResolvedValue(makeUser());
    mocks.checkFollowing.mockResolvedValue(true);
    mocks.unfollow.mockResolvedValue(undefined);

    renderAt();

    fireEvent.click(await screen.findByRole('button', { name: 'Unfollow' }));

    await waitFor(() => expect(mocks.unfollow).toHaveBeenCalledWith('bob'));
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Unfollowed @bob');
    expect(await screen.findByText('4')).toBeTruthy();
  });

  it('starts a conversation from the Message button', async () => {
    useSession.setState({ user: makeUser({ id: 'u-me', username: 'me' }), bootstrap: 'ready' });
    mocks.getByUsername.mockResolvedValue(makeUser());
    mocks.findOrCreate.mockResolvedValue({ id: 'c-9' } as ConversationDTO);

    renderAt();

    fireEvent.click(await screen.findByRole('button', { name: 'Message' }));

    await waitFor(() => expect(mocks.findOrCreate).toHaveBeenCalledWith('bob'));
    expect(await screen.findByText('CONVERSATION-DEST')).toBeTruthy();
  });

  it('shows tabs on your own profile and switches to bookmarks', async () => {
    const bob = makeUser();
    useSession.setState({ user: bob, bootstrap: 'ready' });
    mocks.getByUsername.mockResolvedValue(bob);

    renderAt();

    // own profile: no follow/message, but a tablist
    expect(await screen.findByRole('tab', { name: 'Posts' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Follow' })).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Bookmarks' }));
    expect(await screen.findByTestId('bookmarks-feed')).toBeTruthy();
  });

  it('opens the followers modal from the count button', async () => {
    mocks.getByUsername.mockResolvedValue(makeUser());

    renderAt();

    fireEvent.click(await screen.findByRole('button', { name: /followers/ }));
    expect(await screen.findByTestId('modal-followers')).toBeTruthy();
  });
});

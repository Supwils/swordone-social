import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '@/i18n';
import { useSession } from '@/stores/session.store';
import { useRealtime } from '@/stores/realtime.store';
import type { UserDTO } from '@/api/types';

const mocks = vi.hoisted(() => ({
  logout: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/api/auth.api', () => ({
  register: vi.fn(),
  login: vi.fn(),
  logout: mocks.logout,
  me: vi.fn(),
  changePassword: vi.fn(),
}));
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));
vi.mock('@/features/posts/PostComposer', () => ({
  PostComposer: () => <div data-testid="composer-stub" />,
}));

import { Sidebar } from './Sidebar';

function makeUser(over: Partial<UserDTO> = {}): UserDTO {
  return {
    id: 'u-me',
    username: 'wilson',
    usernameDisplay: 'wilson',
    displayName: 'Wilson',
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
    ...over,
  };
}

function renderSidebar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/feed']}>
        <Sidebar />
        <Routes>
          <Route path="/login" element={<div>LOGIN-DEST</div>} />
          <Route path="*" element={null} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useSession.setState({ user: null, bootstrap: 'ready' });
  useRealtime.setState({ unreadNotifications: 0, unreadConversations: 0 });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useSession.setState({ user: null });
  useRealtime.setState({ unreadNotifications: 0, unreadConversations: 0 });
});

describe('Sidebar', () => {
  it('signed out: shows only public destinations and a sign-in button', () => {
    renderSidebar();

    expect(screen.getByRole('link', { name: 'Global' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'People' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Lab' })).toBeTruthy();

    expect(screen.queryByRole('link', { name: 'Following' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Profile' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
    expect(screen.queryByRole('button', { name: /New post/ })).toBeNull();

    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Sign out/ })).toBeNull();
  });

  it('signed in: shows the personal links with the profile URL bound to the username', () => {
    useSession.setState({ user: makeUser(), bootstrap: 'ready' });
    renderSidebar();

    for (const name of ['Following', 'Notifications', 'Messages', 'Bookmarks', 'Settings']) {
      expect(screen.getByRole('link', { name })).toBeTruthy();
    }
    expect(screen.getByRole('link', { name: 'Profile' }).getAttribute('href')).toBe('/u/wilson');
    expect(screen.getByText('@wilson')).toBeTruthy();
    expect(screen.getByRole('button', { name: /New post/ })).toBeTruthy();
    // no unread anywhere: no badges
    expect(screen.queryByLabelText(/unread/)).toBeNull();
  });

  it('shows unread badges fed by the realtime store', () => {
    useSession.setState({ user: makeUser(), bootstrap: 'ready' });
    useRealtime.setState({ unreadNotifications: 3, unreadConversations: 2 });
    renderSidebar();

    expect(screen.getByLabelText('3 unread')).toBeTruthy();
    expect(screen.getByLabelText('2 unread')).toBeTruthy();
  });

  it('opens the composer dialog from the New post button', async () => {
    useSession.setState({ user: makeUser(), bootstrap: 'ready' });
    renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: /New post/ }));

    // The composer has no painted heading, but the dialog is still named.
    expect(await screen.findByRole('dialog', { name: 'New post' })).toBeTruthy();
    expect(screen.getByTestId('composer-stub')).toBeTruthy();
  });

  it('Sign out calls the auth API, clears the session and lands on /login', async () => {
    mocks.logout.mockResolvedValue(undefined);
    useSession.setState({ user: makeUser(), bootstrap: 'ready' });
    renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: /Sign out/ }));

    await waitFor(() => expect(mocks.logout).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useSession.getState().user).toBeNull());
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Signed out');
    expect(await screen.findByText('LOGIN-DEST')).toBeTruthy();
  });

  it('still clears the session and lands on /login when the logout call fails', async () => {
    mocks.logout.mockRejectedValue(new Error('network down'));
    useSession.setState({ user: makeUser(), bootstrap: 'ready' });
    renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: /Sign out/ }));

    await waitFor(() => expect(useSession.getState().user).toBeNull());
    expect(await screen.findByText('LOGIN-DEST')).toBeTruthy();
  });
});

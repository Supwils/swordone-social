import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '@/i18n';
import { useSession } from '@/stores/session.store';
import { useRealtime } from '@/stores/realtime.store';
import { makeUser } from '@/test/fixtures';

const mocks = vi.hoisted(() => ({ logout: vi.fn(), toastSuccess: vi.fn() }));

vi.mock('@/api/auth.api', () => ({
  register: vi.fn(),
  login: vi.fn(),
  logout: mocks.logout,
  me: vi.fn(),
  changePassword: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: vi.fn() } }));
vi.mock('@/features/posts/PostComposer', () => ({
  PostComposer: () => <div data-testid="composer-stub" />,
}));

import { MobileTabBar } from './MobileTabBar';

const WILSON = makeUser({ id: 'u-me', username: 'wilson', displayName: 'Wilson' });

function renderBar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/feed']}>
        <MobileTabBar />
        <Routes>
          <Route path="/login" element={<div>LOGIN-DEST</div>} />
          <Route path="*" element={null} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useSession.setState({ user: WILSON, bootstrap: 'ready' });
  useRealtime.setState({ unreadNotifications: 0, unreadConversations: 0 });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useSession.setState({ user: null });
});

describe('MobileTabBar more sheet', () => {
  it('offers Messages, Bookmarks, Settings and Sign out', () => {
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    for (const name of ['Messages', 'Bookmarks', 'Settings']) {
      expect(screen.getByRole('link', { name })).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });

  it('is absent when signed out', () => {
    useSession.setState({ user: null });
    renderBar();
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
  });

  it('Sign out ends the session and lands on /login', async () => {
    mocks.logout.mockResolvedValue(undefined);
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(mocks.logout).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useSession.getState().user).toBeNull());
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Signed out');
    expect(await screen.findByText('LOGIN-DEST')).toBeTruthy();
  });
});

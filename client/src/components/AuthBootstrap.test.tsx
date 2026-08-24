import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';
import { useSession } from '@/stores/session.store';
import { useUI } from '@/stores/ui.store';
import type { UserDTO } from '@/api/types';

const mocks = vi.hoisted(() => ({
  me: vi.fn(),
  onUnauthorized: vi.fn(),
}));

vi.mock('@/api/auth.api', () => ({ me: mocks.me }));
vi.mock('@/api/client', () => ({ onUnauthorized: mocks.onUnauthorized }));

import { AuthBootstrap } from './AuthBootstrap';

function makeUser(over: Partial<UserDTO> = {}): UserDTO {
  return {
    id: 'u-1',
    username: 'me',
    usernameDisplay: 'me',
    displayName: 'Me',
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

function renderBootstrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <AuthBootstrap />
    </QueryClientProvider>,
  );
  return { qc, ...view };
}

beforeEach(() => {
  useSession.setState({ user: null, bootstrap: 'pending' });
  useUI.setState({ theme: 'system', language: 'en' });
  mocks.me.mockResolvedValue(null);
  // jsdom has no matchMedia; the 'system' theme path needs one.
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  useUI.setState({ language: 'en' });
  document.documentElement.removeAttribute('data-theme');
});

describe('AuthBootstrap', () => {
  it('hydrates the session from /auth/me and applies the stored language pref', async () => {
    mocks.me.mockResolvedValue(
      makeUser({ preferences: { language: 'zh' } } as unknown as Partial<UserDTO>),
    );

    renderBootstrap();

    await waitFor(() => expect(useSession.getState().bootstrap).toBe('ready'));
    expect(useSession.getState().user?.id).toBe('u-1');
    expect(useUI.getState().language).toBe('zh');
  });

  it('marks the session ready with no user for anonymous visitors', async () => {
    mocks.me.mockResolvedValue(null);

    renderBootstrap();

    await waitFor(() => expect(useSession.getState().bootstrap).toBe('ready'));
    expect(useSession.getState().user).toBeNull();
  });

  it('still becomes ready when /auth/me fails outright', async () => {
    mocks.me.mockRejectedValue(new Error('network down'));

    renderBootstrap();

    await waitFor(() => expect(useSession.getState().bootstrap).toBe('ready'));
    expect(useSession.getState().user).toBeNull();
  });

  it('clears session + cache on a 401 only when someone was signed in', async () => {
    const { qc } = renderBootstrap();
    await waitFor(() => expect(mocks.onUnauthorized).toHaveBeenCalled());
    const handler = mocks.onUnauthorized.mock.calls[0][0] as () => void;
    const clearSpy = vi.spyOn(qc, 'clear');

    // Anonymous 401 (the /auth/me probe itself) must NOT wipe the cache —
    // that would blank the public feed an anonymous visitor is reading.
    act(() => handler());
    expect(clearSpy).not.toHaveBeenCalled();

    act(() => useSession.setState({ user: makeUser(), bootstrap: 'ready' }));
    act(() => handler());
    expect(useSession.getState().user).toBeNull();
    expect(clearSpy).toHaveBeenCalledOnce();
  });

  it('applies the chosen theme to the document root', async () => {
    useUI.setState({ theme: 'dark' });

    renderBootstrap();

    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark'),
    );
  });
});

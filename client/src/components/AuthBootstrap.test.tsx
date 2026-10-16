import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';
import { useSession } from '@/stores/session.store';
import { useUI } from '@/stores/ui.store';
import { useDrafts } from '@/stores/draft.store';
import { makeUser } from '@/test/fixtures';

const mocks = vi.hoisted(() => ({
  me: vi.fn(),
  onUnauthorized: vi.fn(),
}));

vi.mock('@/api/auth.api', () => ({ me: mocks.me }));
vi.mock('@/api/client', () => ({ onUnauthorized: mocks.onUnauthorized }));

import { AuthBootstrap } from './AuthBootstrap';

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
    mocks.me.mockResolvedValue(makeUser({ preferences: { language: 'zh' } }));

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

  it('drops drafts when bootstrap finds the session already gone', async () => {
    // The cookie expired while the tab was closed: no 401 handler ever ran.
    useDrafts.getState().claim('u-old');
    useDrafts.getState().setDraft('post.new', 'left behind');
    mocks.me.mockResolvedValue(null);

    renderBootstrap();

    await waitFor(() => expect(useSession.getState().bootstrap).toBe('ready'));
    expect(useDrafts.getState().drafts).toEqual({});
  });

  it('keeps drafts when /auth/me fails on the network, not on the session', async () => {
    useDrafts.getState().claim('u-1');
    useDrafts.getState().setDraft('post.new', 'still mine');
    mocks.me.mockRejectedValue(new Error('network down'));

    renderBootstrap();

    await waitFor(() => expect(useSession.getState().bootstrap).toBe('ready'));
    expect(useDrafts.getState().getDraft('post.new')?.text).toBe('still mine');
    useDrafts.setState({ drafts: {}, ownerId: null });
  });

  it('drops composer drafts when a signed-in session ends on a 401', async () => {
    // Drafts are text this account typed; the next account on this browser
    // must not open a composer pre-filled with it.
    renderBootstrap();
    await waitFor(() => expect(mocks.onUnauthorized).toHaveBeenCalled());
    const handler = mocks.onUnauthorized.mock.calls[0][0] as () => void;
    useDrafts.getState().setDraft('post.new', 'private half-thought');

    act(() => useSession.setState({ user: makeUser(), bootstrap: 'ready' }));
    act(() => handler());

    expect(useDrafts.getState().drafts).toEqual({});
  });

  it('applies the chosen theme to the document root', async () => {
    useUI.setState({ theme: 'dark' });

    renderBootstrap();

    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'));
  });
});

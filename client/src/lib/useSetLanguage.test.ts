import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { qk } from '@/api/queryKeys';
import { makePost, makeUser } from '@/test/fixtures';

const mocks = vi.hoisted(() => ({ updateMe: vi.fn() }));
vi.mock('@/api/users.api', () => ({ updateMe: mocks.updateMe }));

import { useSetLanguage } from './useSetLanguage';
import { useSession } from '@/stores/session.store';
import { useUI } from '@/stores/ui.store';

let qc: QueryClient;

/** Render the hook under a real QueryClient (it invalidates post reads). */
function renderSetLanguage() {
  qc = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  return renderHook(() => useSetLanguage(), { wrapper });
}

afterEach(() => {
  vi.clearAllMocks();
  useSession.setState({ user: null });
  useUI.getState().setLanguage('en');
  localStorage.removeItem('swil.ui');
});

describe('useSetLanguage', () => {
  it('stores the choice for a signed-in reader, because the server reads it first', async () => {
    // resolveLang prefers preferences.language over ?lang=, so a local-only
    // switch would leave every post body in the old language.
    const updated = makeUser({ id: 'u1', preferences: { language: 'zh' } });
    mocks.updateMe.mockResolvedValue(updated);
    useSession.setState({ user: makeUser({ id: 'u1' }) });

    const { result } = renderSetLanguage();
    await act(() => result.current('zh'));

    expect(useUI.getState().language).toBe('zh');
    expect(mocks.updateMe).toHaveBeenCalledWith({ preferences: { language: 'zh' } });
    // The session copy follows the stored preference.
    expect(useSession.getState().user?.preferences?.language).toBe('zh');
  });

  it('flips the UI language only after the preference write lands', async () => {
    // Post queries are keyed on the UI language. Flipping first refetched every
    // list while the server still held the old preference, and cached the old
    // language's bodies under the new language's key.
    let land: (u: ReturnType<typeof makeUser>) => void = () => undefined;
    mocks.updateMe.mockReturnValue(new Promise((resolve) => (land = resolve)));
    useSession.setState({ user: makeUser({ id: 'u1' }) });

    const { result } = renderSetLanguage();
    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = result.current('zh');
    });

    expect(mocks.updateMe).toHaveBeenCalledOnce();
    expect(useUI.getState().language).toBe('en');

    await act(async () => {
      land(makeUser({ id: 'u1', preferences: { language: 'zh' } }));
      await done;
    });
    expect(useUI.getState().language).toBe('zh');
  });

  it('switches at once when there is no session to store it on', async () => {
    const { result } = renderSetLanguage();
    await act(() => result.current('zh'));

    expect(useUI.getState().language).toBe('zh');
    expect(mocks.updateMe).not.toHaveBeenCalled();
  });

  it('still switches when the write fails', async () => {
    mocks.updateMe.mockRejectedValue(new Error('offline'));
    useSession.setState({ user: makeUser({ id: 'u1' }) });

    const { result } = renderSetLanguage();
    // The rejection is swallowed on purpose — awaiting it must not throw.
    await act(() => result.current('zh'));

    expect(useUI.getState().language).toBe('zh');
  });

  it('marks cached post reads stale after a failed write', async () => {
    // The server kept the old preference, so the new language's keys may hold
    // old-language bodies; they must not stay cached as fresh.
    mocks.updateMe.mockRejectedValue(new Error('offline'));
    useSession.setState({ user: makeUser({ id: 'u1' }) });
    const { result } = renderSetLanguage();
    const detail = qk.posts.byId('64b7f0c2a1d3e4f5a6b7c8d9', 'zh');
    const list = qk.feed.global('zh', 'recommended');
    qc.setQueryData(detail, makePost());
    qc.setQueryData(list, { pages: [], pageParams: [] });

    await act(() => result.current('zh'));

    expect(qc.getQueryState(detail)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(list)?.isInvalidated).toBe(true);
  });

  it('leaves the cache alone when the write lands', async () => {
    mocks.updateMe.mockResolvedValue(makeUser({ id: 'u1', preferences: { language: 'zh' } }));
    useSession.setState({ user: makeUser({ id: 'u1' }) });
    const { result } = renderSetLanguage();
    const list = qk.feed.global('zh', 'recommended');
    qc.setQueryData(list, { pages: [], pageParams: [] });

    await act(() => result.current('zh'));

    expect(qc.getQueryState(list)?.isInvalidated).toBe(false);
  });
});

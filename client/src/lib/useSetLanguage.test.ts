import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { makeUser } from '@/test/fixtures';

const mocks = vi.hoisted(() => ({ updateMe: vi.fn() }));
vi.mock('@/api/users.api', () => ({ updateMe: mocks.updateMe }));

import { useSetLanguage } from './useSetLanguage';
import { useSession } from '@/stores/session.store';
import { useUI } from '@/stores/ui.store';

afterEach(() => {
  vi.clearAllMocks();
  useSession.setState({ user: null });
  useUI.setState({ language: 'en' });
  localStorage.removeItem('swil.ui');
});

describe('useSetLanguage', () => {
  it('stores the choice for a signed-in reader, because the server reads it first', () => {
    // resolveLang prefers preferences.language over ?lang=, so a local-only
    // switch would leave every post body in the old language.
    mocks.updateMe.mockResolvedValue(makeUser({ id: 'u1' }));
    useSession.setState({ user: makeUser({ id: 'u1' }) });

    const { result } = renderHook(() => useSetLanguage());
    act(() => result.current('zh'));

    expect(useUI.getState().language).toBe('zh');
    expect(mocks.updateMe).toHaveBeenCalledWith({ preferences: { language: 'zh' } });
  });

  it('switches anyway when there is no session to store it on', () => {
    const { result } = renderHook(() => useSetLanguage());
    act(() => result.current('zh'));

    expect(useUI.getState().language).toBe('zh');
    expect(mocks.updateMe).not.toHaveBeenCalled();
  });

  it('still switches when the write fails', async () => {
    mocks.updateMe.mockRejectedValue(new Error('offline'));
    useSession.setState({ user: makeUser({ id: 'u1' }) });

    const { result } = renderHook(() => useSetLanguage());
    act(() => result.current('zh'));

    expect(useUI.getState().language).toBe('zh');
    // The rejection is swallowed on purpose — assert it does not escape.
    await expect(mocks.updateMe.mock.results[0].value).rejects.toThrow('offline');
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { usePageTitle } from './usePageTitle';

afterEach(cleanup);

describe('usePageTitle', () => {
  it('sets the tab title with the app suffix', () => {
    renderHook(() => usePageTitle('Messages'));
    expect(document.title).toBe('Messages · SwordOne');
  });

  it('tracks title changes across rerenders', () => {
    const { rerender } = renderHook(({ t }: { t: string }) => usePageTitle(t), {
      initialProps: { t: 'Global' },
    });
    expect(document.title).toBe('Global · SwordOne');

    rerender({ t: 'Bookmarks' });
    expect(document.title).toBe('Bookmarks · SwordOne');
  });

  it('falls back to the bare app name for an empty title', () => {
    renderHook(() => usePageTitle(''));
    expect(document.title).toBe('SwordOne');
  });

  it('restores the base title on unmount', () => {
    const { unmount } = renderHook(() => usePageTitle('Settings'));
    expect(document.title).toBe('Settings · SwordOne');

    unmount();
    expect(document.title).toBe('SwordOne');
  });
});

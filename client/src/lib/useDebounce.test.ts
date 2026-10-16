import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDebounce } from './useDebounce';

describe('useDebounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the initial value immediately', () => {
    const { result } = renderHook(() => useDebounce('initial', 200));
    expect(result.current).toBe('initial');
  });

  it('does not update before the delay elapses', () => {
    const { result, rerender } = renderHook(({ v }: { v: string }) => useDebounce(v, 200), {
      initialProps: { v: 'a' },
    });
    rerender({ v: 'b' });
    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(result.current).toBe('a');
  });

  it('updates after the delay elapses', () => {
    const { result, rerender } = renderHook(({ v }: { v: string }) => useDebounce(v, 200), {
      initialProps: { v: 'a' },
    });
    rerender({ v: 'b' });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe('b');
  });

  it('coalesces rapid changes — only the last value wins', () => {
    const { result, rerender } = renderHook(({ v }: { v: string }) => useDebounce(v, 200), {
      initialProps: { v: 'a' },
    });
    rerender({ v: 'b' });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender({ v: 'c' });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender({ v: 'd' });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe('d');
  });

  it('works with non-string types', () => {
    const { result, rerender } = renderHook(({ v }: { v: number }) => useDebounce(v, 100), {
      initialProps: { v: 1 },
    });
    rerender({ v: 42 });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe(42);
  });
});

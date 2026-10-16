import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useInfiniteScroll } from './useInfiniteScroll';

/**
 * jsdom has no IntersectionObserver — a controllable stub stands in, capturing
 * every constructed observer so tests can fire visibility changes by hand and
 * assert observe/disconnect bookkeeping.
 */
type IOCallback = (entries: Array<Pick<IntersectionObserverEntry, 'isIntersecting'>>) => void;

class MockObserver {
  static instances: MockObserver[] = [];
  callback: IOCallback;
  options: IntersectionObserverInit | undefined;
  observed: Element[] = [];
  disconnected = false;

  constructor(cb: IOCallback, options?: IntersectionObserverInit) {
    this.callback = cb;
    this.options = options;
    MockObserver.instances.push(this);
  }

  observe(el: Element) {
    this.observed.push(el);
  }

  disconnect() {
    this.disconnected = true;
  }

  unobserve() {}
}

function Harness(props: {
  hasNextPage: boolean;
  isFetching: boolean;
  onLoadMore: () => void;
  rootMargin?: string;
}) {
  const ref = useInfiniteScroll(props);
  return <div ref={ref} data-testid="sentinel" />;
}

function lastObserver(): MockObserver {
  const inst = MockObserver.instances[MockObserver.instances.length - 1];
  expect(inst, 'an IntersectionObserver instance').toBeDefined();
  return inst;
}

function intersect(observer: MockObserver) {
  act(() => observer.callback([{ isIntersecting: true }]));
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', MockObserver as unknown as typeof IntersectionObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  MockObserver.instances.length = 0;
});

describe('useInfiniteScroll', () => {
  it('observes the sentinel and fires onLoadMore when it intersects', () => {
    const onLoadMore = vi.fn();
    const { getByTestId } = render(
      <Harness hasNextPage isFetching={false} onLoadMore={onLoadMore} />,
    );

    const observer = lastObserver();
    expect(observer.observed).toEqual([getByTestId('sentinel')]);

    intersect(observer);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('does not fire when the sentinel is reported but not intersecting', () => {
    const onLoadMore = vi.fn();
    render(<Harness hasNextPage isFetching={false} onLoadMore={onLoadMore} />);

    act(() => lastObserver().callback([{ isIntersecting: false }]));
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('does not fire while a fetch is already in flight', () => {
    const onLoadMore = vi.fn();
    render(<Harness hasNextPage isFetching onLoadMore={onLoadMore} />);

    intersect(lastObserver());
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('creates no observer at all when there is no next page', () => {
    const onLoadMore = vi.fn();
    render(<Harness hasNextPage={false} isFetching={false} onLoadMore={onLoadMore} />);

    expect(MockObserver.instances).toHaveLength(0);
  });

  it('disconnects the stale observer when dependencies change', () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(<Harness hasNextPage isFetching={false} onLoadMore={onLoadMore} />);
    const first = lastObserver();

    rerender(<Harness hasNextPage isFetching onLoadMore={onLoadMore} />);

    expect(first.disconnected).toBe(true);
    const second = lastObserver();
    expect(second).not.toBe(first);
    // The fresh observer closes over isFetching=true, so it must not fire.
    intersect(second);
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('disconnects on unmount', () => {
    const { unmount } = render(<Harness hasNextPage isFetching={false} onLoadMore={vi.fn()} />);
    const observer = lastObserver();

    unmount();
    expect(observer.disconnected).toBe(true);
  });

  it('applies the default rootMargin and honours an override', () => {
    const { rerender } = render(<Harness hasNextPage isFetching={false} onLoadMore={vi.fn()} />);
    expect(lastObserver().options?.rootMargin).toBe('200px 0px');

    rerender(<Harness hasNextPage isFetching={false} onLoadMore={vi.fn()} rootMargin="0px" />);
    expect(lastObserver().options?.rootMargin).toBe('0px');
  });
});

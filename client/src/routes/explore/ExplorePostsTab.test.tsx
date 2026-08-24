import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import '@/i18n';

const mocks = vi.hoisted(() => ({
  searchPosts: vi.fn(),
  track: vi.fn(),
}));
vi.mock('@/api/posts.api', () => ({ searchPosts: mocks.searchPosts }));
vi.mock('@/lib/analytics', () => ({ track: mocks.track }));
vi.mock('@/features/posts/PostCard', () => ({
  PostCard: ({ post }: { post: { text: string } }) => (
    <article data-testid="post-card">{post.text}</article>
  ),
}));
vi.mock('@/components/InfiniteScrollSentinel', () => ({
  InfiniteScrollSentinel: () => null,
}));

import { ExplorePostsTab } from './ExplorePostsTab';

function renderTab(url = '/explore') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <ExplorePostsTab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.searchPosts.mockResolvedValue({ items: [], nextCursor: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ExplorePostsTab', () => {
  it('starts with the browse query and the start-searching empty state', async () => {
    renderTab();

    expect(await screen.findByText('Search posts')).toBeTruthy();
    expect(screen.getByText('Type a keyword to find posts.')).toBeTruthy();
    expect(mocks.searchPosts).toHaveBeenCalledWith(
      expect.objectContaining({ q: undefined }),
    );
  });

  it('debounces typing into a search request and tracks it', async () => {
    mocks.searchPosts.mockImplementation(async ({ q }: { q?: string }) =>
      q === 'compilers'
        ? { items: [{ id: 'p-1', text: 'a compilers post' }], nextCursor: null }
        : { items: [], nextCursor: null },
    );

    renderTab();
    // Named for assistive tech, not just by its placeholder.
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search posts…' }), {
      target: { value: 'compilers' },
    });

    // 300ms debounce: wait on the request, not on a sleep.
    await waitFor(() =>
      expect(mocks.searchPosts).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'compilers' }),
      ),
    );
    expect(await screen.findByText('a compilers post')).toBeTruthy();
    await waitFor(() =>
      expect(mocks.track).toHaveBeenCalledWith('search_query', { q: 'compilers' }),
    );
  });

  it('shows the no-results state for a query without matches', async () => {
    renderTab('/explore?q=zzz');

    expect(await screen.findByText('No results')).toBeTruthy();
    expect(screen.getByText('Try different keywords.')).toBeTruthy();
  });
});

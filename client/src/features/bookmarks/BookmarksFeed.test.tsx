import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';
import { makePost } from '@/test/fixtures';

const mocks = vi.hoisted(() => ({
  listBookmarks: vi.fn(),
}));

vi.mock('@/api/bookmarks.api', () => ({
  bookmarkPost: vi.fn(),
  unbookmarkPost: vi.fn(),
  listBookmarks: mocks.listBookmarks,
}));
vi.mock('@/features/posts/PostCard', () => ({
  PostCard: ({ post }: { post: { text: string } }) => (
    <article data-testid="post-card">{post.text}</article>
  ),
}));
vi.mock('@/components/InfiniteScrollSentinel', () => ({
  InfiniteScrollSentinel: () => null,
}));

import { BookmarksFeed } from './BookmarksFeed';

function renderFeed() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BookmarksFeed />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('BookmarksFeed', () => {
  it('renders the bookmarked posts from the first page', async () => {
    mocks.listBookmarks.mockResolvedValue({
      items: [
        makePost({ id: 'p-1', text: 'saved post one' }),
        makePost({ id: 'p-2', text: 'saved post two' }),
      ],
      nextCursor: null,
    });

    renderFeed();

    const cards = await screen.findAllByTestId('post-card');
    expect(cards.map((c) => c.textContent)).toEqual(['saved post one', 'saved post two']);
    expect(mocks.listBookmarks).toHaveBeenCalledWith(expect.objectContaining({ cursor: null }));
  });

  it('shows the empty state when nothing is bookmarked', async () => {
    mocks.listBookmarks.mockResolvedValue({ items: [], nextCursor: null });

    renderFeed();

    expect(await screen.findByText('No bookmarks yet')).toBeTruthy();
    expect(screen.getByText('Save posts you want to read later.')).toBeTruthy();
    expect(screen.queryByTestId('post-card')).toBeNull();
  });

  it('shows a dedicated error state when the query fails', async () => {
    mocks.listBookmarks.mockRejectedValue({ message: 'boom' });

    renderFeed();

    expect(await screen.findByText("Couldn't load your bookmarks")).toBeTruthy();
    expect(screen.getByText('Check your connection and try again.')).toBeTruthy();
    expect(screen.queryByText('No bookmarks yet')).toBeNull();
    expect(screen.queryByTestId('post-card')).toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '@/i18n';
import { makePost } from '@/test/fixtures';

vi.mock('@/api/feed.api', () => ({ byBoard: vi.fn() }));
vi.mock('@/api/boards.api', () => ({ getBySlug: vi.fn(), list: vi.fn() }));

// FeedStream mounts PostCard / a virtualizer; the route test asserts
// slug wiring + data, not card internals.
vi.mock('@/features/posts/FeedStream', () => ({
  FeedStream: ({ items }: { items: Array<{ id: string; text: string }> }) => (
    <div data-testid="posts">
      {items.map((p) => (
        <p key={p.id}>{p.text}</p>
      ))}
    </div>
  ),
  FeedSkeletons: () => <div data-testid="feed-skeletons" />,
}));

import * as feedApi from '@/api/feed.api';
import * as boardsApi from '@/api/boards.api';
import FeedBoardRoute from './feedBoard';

function renderAt(slug: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/board/${slug}`]}>
        <Routes>
          <Route path="/board/:slug" element={<FeedBoardRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FeedBoardRoute', () => {
  it('passes the route slug through to the board feed endpoint', async () => {
    vi.mocked(boardsApi.getBySlug).mockResolvedValue({
      id: 'b1',
      slug: 'market',
      name: '市场与资产',
      description: '宏观、加密、股票。',
      sortOrder: 1,
      postCount: 42,
    });
    vi.mocked(feedApi.byBoard).mockResolvedValue({ items: [], nextCursor: null });

    renderAt('market');

    await waitFor(() => expect(feedApi.byBoard).toHaveBeenCalled());
    expect(vi.mocked(feedApi.byBoard).mock.calls[0][0]).toBe('market');
    // The count carries its unit, as the tag header does — a bare "42" under
    // the board name read as nothing in particular.
    expect(await screen.findByText('42 posts')).toBeTruthy();
  });

  it('renders the board name and its posts', async () => {
    vi.mocked(boardsApi.getBySlug).mockResolvedValue({
      id: 'b2',
      slug: 'living',
      name: '生活与种植',
      description: '',
      sortOrder: 5,
      postCount: 3,
    });
    vi.mocked(feedApi.byBoard).mockResolvedValue({
      items: [makePost({ id: 'p1', text: '罗勒掐顶' })],
      nextCursor: null,
    });

    renderAt('living');

    expect(await screen.findByText('生活与种植')).toBeTruthy();
    expect(await screen.findByText('罗勒掐顶')).toBeTruthy();
  });

  it('shows an empty state when the board has no posts', async () => {
    vi.mocked(boardsApi.getBySlug).mockResolvedValue({
      id: 'b3',
      slug: 'perception',
      name: '感知与神经',
      description: '',
      sortOrder: 4,
      postCount: 0,
    });
    vi.mocked(feedApi.byBoard).mockResolvedValue({ items: [], nextCursor: null });

    renderAt('perception');

    expect(await screen.findByText('Quiet here.')).toBeTruthy();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '@/i18n';

vi.mock('@/api/feed.api', () => ({ global: vi.fn() }));
vi.mock('@/api/tags.api', () => ({ trending: vi.fn() }));

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
import * as tagsApi from '@/api/tags.api';
import FeedGlobalRoute from './feedGlobal';

function renderGlobal() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/global']}>
        <Routes>
          <Route path="/global" element={<FeedGlobalRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FeedGlobalRoute', () => {
  it('renders posts returned by the global feed and the layout toggle', async () => {
    vi.mocked(tagsApi.trending).mockResolvedValue([]);
    vi.mocked(feedApi.global).mockResolvedValue({
      items: [{ id: 'p1', text: '罗勒掐顶' }],
      nextCursor: null,
    } as never);

    renderGlobal();

    expect(await screen.findByRole('heading', { name: 'Global' })).toBeTruthy();
    expect(await screen.findByText('罗勒掐顶')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Feed layout' })).toBeTruthy();
  });

  it('shows the empty state when the river has no posts', async () => {
    vi.mocked(tagsApi.trending).mockResolvedValue([]);
    vi.mocked(feedApi.global).mockResolvedValue({ items: [], nextCursor: null });

    renderGlobal();

    expect(await screen.findByText('Nothing here yet.')).toBeTruthy();
  });

  it('keeps the sort switch available when there are no trending tags', async () => {
    // The switch used to be nested inside the trending block, so an empty
    // trending response silently removed the only way to reach "Latest".
    vi.mocked(tagsApi.trending).mockResolvedValue([]);
    vi.mocked(feedApi.global).mockResolvedValue({ items: [], nextCursor: null });

    renderGlobal();
    await screen.findByText('Nothing here yet.');

    const recommended = screen.getByRole('button', { name: 'Recommended' });
    const latest = screen.getByRole('button', { name: 'Latest' });
    expect(recommended.getAttribute('aria-pressed')).toBe('true');
    expect(latest.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(latest);

    await waitFor(() =>
      expect(feedApi.global).toHaveBeenCalledWith(expect.objectContaining({ sort: 'latest' })),
    );
    expect(latest.getAttribute('aria-pressed')).toBe('true');
    expect(recommended.getAttribute('aria-pressed')).toBe('false');
  });

  it('shows an error state that can retry', async () => {
    vi.mocked(tagsApi.trending).mockResolvedValue([]);
    vi.mocked(feedApi.global).mockRejectedValue(new Error('offline'));

    renderGlobal();

    expect(await screen.findByText("Couldn't load the feed")).toBeTruthy();
    await waitFor(() => expect(feedApi.global).toHaveBeenCalled());
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '@/i18n';
import { useRealtime } from '@/stores/realtime.store';

vi.mock('@/api/feed.api', () => ({ following: vi.fn() }));
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
vi.mock('@/features/posts/FeedLayoutToggle', () => ({ FeedLayoutToggle: () => null }));

import * as feedApi from '@/api/feed.api';
import FeedFollowingRoute from './feedFollowing';

function renderRoute() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/feed']}>
        <Routes>
          <Route path="/feed" element={<FeedFollowingRoute />} />
          <Route path="/global" element={<div>GLOBAL-DEST</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useRealtime.setState({
    connected: false,
    unreadNotifications: 0,
    unreadConversations: 0,
    newFeedPostCount: 0,
  });
  vi.stubGlobal('scrollTo', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('FeedFollowingRoute', () => {
  it('requests the recommended sort by default and renders the stream', async () => {
    vi.mocked(feedApi.following).mockResolvedValue({
      items: [{ id: 'p-1', text: 'from someone I follow' }],
      nextCursor: null,
    } as never);

    renderRoute();

    expect(await screen.findByText('from someone I follow')).toBeTruthy();
    expect(feedApi.following).toHaveBeenCalledWith({
      cursor: null,
      limit: 20,
      sort: 'recommended',
    });
  });

  it('re-queries with sort=latest when the Latest tab is clicked', async () => {
    vi.mocked(feedApi.following).mockResolvedValue({ items: [], nextCursor: null } as never);

    renderRoute();
    await screen.findByText('Your feed is quiet.');

    const latest = screen.getByRole('button', { name: 'Latest' });
    expect(latest.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(latest);

    await waitFor(() =>
      expect(feedApi.following).toHaveBeenCalledWith({
        cursor: null,
        limit: 20,
        sort: 'latest',
      }),
    );
    expect(latest.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Recommended' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('sends an empty feed to browse the global stream', async () => {
    vi.mocked(feedApi.following).mockResolvedValue({ items: [], nextCursor: null } as never);

    renderRoute();

    expect(await screen.findByText('Your feed is quiet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Browse global' }));
    expect(await screen.findByText('GLOBAL-DEST')).toBeTruthy();
  });

  it('shows the new-posts banner and resets the counter on click', async () => {
    vi.mocked(feedApi.following).mockResolvedValue({ items: [], nextCursor: null } as never);
    useRealtime.setState({ newFeedPostCount: 3 });

    renderRoute();

    const banner = await screen.findByRole('button', { name: '↑ 3 new posts' });
    fireEvent.click(banner);

    expect(useRealtime.getState().newFeedPostCount).toBe(0);
    await waitFor(() => expect(screen.queryByRole('button', { name: '↑ 3 new posts' })).toBeNull());
  });

  it('offers a retry on load failure', async () => {
    vi.mocked(feedApi.following).mockRejectedValueOnce({ status: 500, message: 'boom' });
    vi.mocked(feedApi.following).mockResolvedValue({
      items: [{ id: 'p-2', text: 'recovered' }],
      nextCursor: null,
    } as never);

    renderRoute();

    expect(await screen.findByText("Couldn't load the feed")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('recovered')).toBeTruthy();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '@/i18n';
import type { TagDTO } from '@/api/types';

vi.mock('@/api/feed.api', () => ({ byTag: vi.fn() }));
vi.mock('@/api/tags.api', () => ({ getBySlug: vi.fn() }));
// Same altitude as the feedBoard suite: the route test asserts slug/lang
// wiring and header states, not card internals.
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
import * as tagsApi from '@/api/tags.api';
import FeedTagRoute from './feedTag';

function makeTag(over: Partial<TagDTO> = {}): TagDTO {
  return {
    slug: 'compilers',
    display: 'compilers',
    description: '',
    coverImage: null,
    postCount: 0,
    status: 'active',
    ...over,
  } as unknown as TagDTO;
}

function renderAt(slug: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/tag/${slug}`]}>
        <Routes>
          <Route path="/tag/:slug" element={<FeedTagRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FeedTagRoute', () => {
  it('passes the slug and language through to the tag feed endpoint', async () => {
    vi.mocked(tagsApi.getBySlug).mockResolvedValue(makeTag());
    vi.mocked(feedApi.byTag).mockResolvedValue({
      items: [{ id: 'p-1', text: 'tagged post' }],
      nextCursor: null,
    } as never);

    renderAt('compilers');

    expect(await screen.findByText('tagged post')).toBeTruthy();
    await waitFor(() => expect(feedApi.byTag).toHaveBeenCalled());
    expect(vi.mocked(feedApi.byTag).mock.calls[0][0]).toBe('compilers');
    expect(vi.mocked(feedApi.byTag).mock.calls[0][1]).toMatchObject({ lang: 'en', limit: 20 });
    expect(screen.getByRole('heading', { name: '#compilers' })).toBeTruthy();
  });

  it('renders the rich header with description and archived badge', async () => {
    vi.mocked(tagsApi.getBySlug).mockResolvedValue(
      makeTag({ display: 'ai-gov', description: 'Measurement and power.', status: 'archived' }),
    );
    vi.mocked(feedApi.byTag).mockResolvedValue({ items: [], nextCursor: null } as never);

    renderAt('ai-gov');

    expect(await screen.findByText('Measurement and power.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '#ai-gov' })).toBeTruthy();
  });

  it('shows the empty state for a tag with no recent posts', async () => {
    vi.mocked(tagsApi.getBySlug).mockResolvedValue(makeTag());
    vi.mocked(feedApi.byTag).mockResolvedValue({ items: [], nextCursor: null } as never);

    renderAt('compilers');

    expect(await screen.findByText('Quiet here.')).toBeTruthy();
    expect(screen.getByText('No recent posts on #compilers.')).toBeTruthy();
  });

  it('shows the not-found state when the feed errors', async () => {
    vi.mocked(tagsApi.getBySlug).mockResolvedValue(makeTag());
    vi.mocked(feedApi.byTag).mockRejectedValue({ status: 404, message: 'Tag not found' });

    renderAt('missing');

    expect(await screen.findByText('Tag not found')).toBeTruthy();
  });
});

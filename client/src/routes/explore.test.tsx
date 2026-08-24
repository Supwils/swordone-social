import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import '@/i18n';
import type { ExploreSummaryDTO } from '@/api/types';

const mocks = vi.hoisted(() => ({
  getExploreSummary: vi.fn(),
  track: vi.fn(),
}));

vi.mock('@/api/feed.api', () => ({ getExploreSummary: mocks.getExploreSummary }));
vi.mock('@/lib/analytics', () => ({ track: mocks.track }));
// The route test asserts tab routing and section wiring; every panel has its
// own concerns (and several fetch on mount), so all six are shallow stubs.
vi.mock('./explore/ExploreHero', () => ({
  ExploreHero: ({ post }: { post: unknown }) => (
    <div data-testid="hero">{post ? 'featured' : 'no-featured'}</div>
  ),
}));
vi.mock('./explore/ExploreAgents', () => ({
  ExploreAgents: () => <div data-testid="agents" />,
}));
vi.mock('./explore/ExploreTopics', () => ({
  ExploreTopics: () => <div data-testid="topics" />,
}));
vi.mock('./explore/ExploreTrendingTags', () => ({
  ExploreTrendingTags: () => <div data-testid="trending-tags" />,
}));
vi.mock('./explore/ExplorePostsTab', () => ({
  ExplorePostsTab: () => <div data-testid="posts-tab" />,
}));
vi.mock('./explore/ExplorePeopleTab', () => ({
  ExplorePeopleTab: () => <div data-testid="people-tab" />,
}));

import ExploreRoute from './explore';

function makeSummary(): ExploreSummaryDTO {
  return {
    featuredPost: { id: 'p-1' },
    agents: [],
    featuredTopics: [],
    trendingTags: [],
  } as unknown as ExploreSummaryDTO;
}

function renderAt(url = '/explore') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <ExploreRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ExploreRoute', () => {
  it('defaults to the posts tab and renders every summary section', async () => {
    mocks.getExploreSummary.mockResolvedValue(makeSummary());

    renderAt();

    expect(await screen.findByTestId('agents')).toBeTruthy();
    expect(screen.getByTestId('topics')).toBeTruthy();
    expect(screen.getByTestId('trending-tags')).toBeTruthy();
    expect(screen.getByTestId('hero').textContent).toBe('featured');
    expect(screen.getByTestId('posts-tab')).toBeTruthy();
    expect(screen.queryByTestId('people-tab')).toBeNull();
  });

  it('switches to the people tab and tracks the switch', async () => {
    mocks.getExploreSummary.mockResolvedValue(makeSummary());

    renderAt();
    await screen.findByTestId('agents');

    const posts = screen.getByRole('button', { name: 'Posts' });
    const people = screen.getByRole('button', { name: 'People' });
    expect(posts.getAttribute('aria-pressed')).toBe('true');
    expect(people.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(people);

    expect(screen.getByTestId('people-tab')).toBeTruthy();
    expect(screen.queryByTestId('posts-tab')).toBeNull();
    expect(people.getAttribute('aria-pressed')).toBe('true');
    expect(posts.getAttribute('aria-pressed')).toBe('false');
    expect(mocks.track).toHaveBeenCalledWith('tab_switch', { area: 'explore', tab: 'people' });
  });

  it('honours ?tab=people on entry and tolerates a pending summary', () => {
    mocks.getExploreSummary.mockImplementation(() => new Promise(() => undefined));

    renderAt('/explore?tab=people');

    expect(screen.getByTestId('people-tab')).toBeTruthy();
    // No summary yet: hero renders its empty variant, sections stay hidden.
    expect(screen.getByTestId('hero').textContent).toBe('no-featured');
    expect(screen.queryByTestId('agents')).toBeNull();
  });
});

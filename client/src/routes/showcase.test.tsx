import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import '@/i18n';
import { makePost, makeUserLite } from '@/test/fixtures';

const mocks = vi.hoisted(() => ({
  getShowcase: vi.fn(),
  listForPost: vi.fn(),
}));

vi.mock('@/api/posts.api', () => ({ getShowcase: mocks.getShowcase }));
vi.mock('@/api/comments.api', () => ({ listForPost: mocks.listForPost }));

import ShowcaseRoute from './showcase';

const ZENITH_POST = makePost({
  id: 'p-1',
  text: 'A quiet thought about compilers',
  author: makeUserLite({
    id: 'u-a',
    username: 'zenith',
    usernameDisplay: 'zenith',
    displayName: 'Zenith',
    isAgent: true,
  }),
  likeCount: 4,
  commentCount: 1,
});

function renderRoute() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <ShowcaseRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // relativeTime() computes from Date.now(); pin it so "Xd ago" labels can
  // never drift with the wall clock.
  vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-01-03T00:00:00.000Z').getTime());
  mocks.listForPost.mockResolvedValue({ items: [], nextCursor: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('ShowcaseRoute', () => {
  it('renders the public wall with cards, AI badges, and the join CTA', async () => {
    mocks.getShowcase.mockResolvedValue([
      ZENITH_POST,
      makePost({
        id: 'p-2',
        text: 'Human here, mostly lurking',
        author: makeUserLite({
          id: 'u-h',
          username: 'sam',
          usernameDisplay: 'sam',
          displayName: 'Sam',
        }),
      }),
    ]);

    renderRoute();

    expect(await screen.findByText(/A quiet thought about compilers/)).toBeTruthy();
    expect(screen.getByText(/Human here, mostly lurking/)).toBeTruthy();
    expect(screen.getByText('A community written by AI and humans')).toBeTruthy();
    // Only the agent-authored card carries the AI badge.
    expect(screen.getAllByText('AI')).toHaveLength(1);
    expect(screen.getAllByText('2d ago')).toHaveLength(2);
    expect(mocks.getShowcase).toHaveBeenCalledWith('en');
  });

  it('opens the preview modal with comments and registration CTA on card click', async () => {
    mocks.getShowcase.mockResolvedValue([ZENITH_POST]);
    mocks.listForPost.mockResolvedValue({
      items: [
        {
          id: 'c-1',
          text: 'agreed, quietly',
          author: {
            id: 'u-b',
            username: 'bo',
            usernameDisplay: 'bo',
            displayName: 'Bo',
            avatarUrl: null,
            headline: '',
            profileTags: [],
            isAgent: false,
          },
          createdAt: '2026-01-02T00:00:00.000Z',
        },
      ],
      nextCursor: null,
    });

    renderRoute();

    fireEvent.click(await screen.findByRole('button', { name: "Zenith's post" }));

    expect(await screen.findByRole('dialog', { name: "Zenith's post" })).toBeTruthy();
    expect(await screen.findByText('agreed, quietly')).toBeTruthy();
    await waitFor(() =>
      expect(mocks.listForPost).toHaveBeenCalledWith('p-1', { limit: 5 }),
    );
    expect(screen.getByText('@zenith')).toBeTruthy();
    expect(screen.getByText('Join this community and join the conversation')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByText('@zenith')).toBeNull());
  });
});

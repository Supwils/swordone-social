import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '@/i18n';
import { useSession } from '@/stores/session.store';
import { useUI } from '@/stores/ui.store';
import type { CommentDTO, PostDTO, UserDTO } from '@/api/types';

const mocks = vi.hoisted(() => ({
  getById: vi.fn(),
  listForPost: vi.fn(),
  createComment: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  track: vi.fn(),
}));

vi.mock('@/api/posts.api', () => ({ getById: mocks.getById }));
vi.mock('@/api/comments.api', () => ({
  listForPost: mocks.listForPost,
  create: mocks.createComment,
}));
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));
vi.mock('@/lib/analytics', () => ({ track: mocks.track }));
// The route test asserts thread wiring, not card internals (PostCard has its
// own suite) and not IntersectionObserver plumbing (useInfiniteScroll has its
// own suite).
vi.mock('@/features/posts/PostCard', () => ({
  PostCard: ({ post }: { post: { text: string } }) => (
    <article data-testid="post-card">{post.text}</article>
  ),
}));
vi.mock('@/components/InfiniteScrollSentinel', () => ({
  InfiniteScrollSentinel: () => null,
}));

import PostRoute from './post';

function makeUser(id = 'me'): UserDTO {
  return {
    id,
    username: 'me',
    usernameDisplay: 'me',
    displayName: 'Me',
    bio: '',
    headline: '',
    avatarUrl: null,
    coverUrl: null,
    location: null,
    website: null,
    profileTags: [],
    isAgent: false,
    followerCount: 0,
    followingCount: 0,
    postCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function makePost(over: Partial<PostDTO> = {}): PostDTO {
  return {
    id: 'p-1',
    text: 'The post body',
    commentCount: 0,
    author: {
      id: 'u-z',
      username: 'zed',
      usernameDisplay: 'zed',
      displayName: 'Zed',
      avatarUrl: null,
      headline: '',
      profileTags: [],
      isAgent: false,
    },
    ...over,
  } as unknown as PostDTO;
}

function makeComment(id: string, text: string): CommentDTO {
  return {
    id,
    text,
    author: {
      id: 'u-a',
      username: 'alice',
      usernameDisplay: 'alice',
      displayName: 'Alice',
      avatarUrl: null,
      headline: '',
      profileTags: [],
      isAgent: false,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
  } as unknown as CommentDTO;
}

function renderAt(id = 'p-1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/post/${id}`]}>
        <Routes>
          <Route path="/post/:id" element={<PostRoute />} />
          <Route path="/global" element={<div>GLOBAL-DEST</div>} />
          <Route path="/feed" element={<div>FEED-DEST</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useSession.setState({ user: null, bootstrap: 'ready' });
  mocks.listForPost.mockResolvedValue({ items: [], nextCursor: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // One test switches language, and i18n is module-level state shared by every
  // test in this file. Reset through the action, not setState: only the action
  // calls i18n.changeLanguage, so setState would leave the copy in 中文.
  useUI.getState().setLanguage('en');
  localStorage.removeItem('swil.ui');
});

describe('PostRoute', () => {
  it('renders the post, its comments, and tracks the view', async () => {
    mocks.getById.mockResolvedValue(makePost({ commentCount: 2 }));
    mocks.listForPost.mockResolvedValue({
      items: [makeComment('c-1', 'first comment'), makeComment('c-2', 'second comment')],
      nextCursor: null,
    });

    renderAt();

    expect((await screen.findByTestId('post-card')).textContent).toBe('The post body');
    expect(await screen.findByText('first comment')).toBeTruthy();
    expect(await screen.findByText('second comment')).toBeTruthy();
    expect(mocks.track).toHaveBeenCalledWith('post_view', { postId: 'p-1' });
    // Comments are requested with the viewer's language for translations.
    expect(mocks.listForPost).toHaveBeenCalledWith('p-1', {
      cursor: null,
      limit: 50,
      lang: 'en',
    });
  });

  it('asks for the post in the viewer language, and refetches when it changes', async () => {
    // The permalink used to send no lang at all, so an anonymous reader with a
    // 中文 UI got the English body: resolveLang has no stored preference to fall
    // back to and defaults to en.
    mocks.getById.mockResolvedValue(makePost());
    renderAt();

    await screen.findByTestId('post-card');
    expect(mocks.getById).toHaveBeenCalledWith('p-1', 'en');

    mocks.getById.mockResolvedValue(makePost({ text: '中文正文' }));
    useUI.getState().setLanguage('zh');

    await waitFor(() => expect(mocks.getById).toHaveBeenCalledWith('p-1', 'zh'));
    expect((await screen.findByTestId('post-card')).textContent).toBe('中文正文');
  });

  it('offers a sign-in link instead of the composer when signed out', async () => {
    mocks.getById.mockResolvedValue(makePost());

    const { container } = renderAt();

    await screen.findByTestId('post-card');
    expect(container.querySelector('a[href="/login"]')).not.toBeNull();
    expect(screen.queryByLabelText('Your comment')).toBeNull();
  });

  it('submits a comment, clears the box, and toasts', async () => {
    useSession.setState({ user: makeUser(), bootstrap: 'ready' });
    mocks.getById.mockResolvedValue(makePost());
    mocks.createComment.mockResolvedValue(makeComment('c-9', 'Nice thread'));

    renderAt();

    const box = (await screen.findByLabelText('Your comment')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Nice thread' } });
    const form = box.closest('form') as HTMLElement;
    fireEvent.submit(form);

    await waitFor(() =>
      expect(mocks.createComment).toHaveBeenCalledWith('p-1', { text: 'Nice thread' }),
    );
    expect(mocks.toastSuccess).toHaveBeenCalled();
    await waitFor(() => expect(box.value).toBe(''));
  });

  it('does not submit a whitespace-only comment', async () => {
    useSession.setState({ user: makeUser(), bootstrap: 'ready' });
    mocks.getById.mockResolvedValue(makePost());

    renderAt();

    const box = (await screen.findByLabelText('Your comment')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '   ' } });
    fireEvent.submit(box.closest('form') as HTMLElement);

    await waitFor(() => expect(screen.queryByText('Posting…')).toBeNull());
    expect(mocks.createComment).not.toHaveBeenCalled();
  });

  it('shows the not-found state on 404 and routes back to /global signed out', async () => {
    mocks.getById.mockRejectedValue({ status: 404, message: 'Post not found' });

    renderAt('missing');

    expect(await screen.findByText('Post not found')).toBeTruthy();
    expect(screen.getByText('This post may have been removed or is private.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button'));
    expect(await screen.findByText('GLOBAL-DEST')).toBeTruthy();
  });

  it('routes back to /feed on 404 when signed in', async () => {
    useSession.setState({ user: makeUser(), bootstrap: 'ready' });
    mocks.getById.mockRejectedValue({ status: 404, message: 'Post not found' });

    renderAt('missing');

    await screen.findByText('Post not found');
    fireEvent.click(screen.getByRole('button'));
    expect(await screen.findByText('FEED-DEST')).toBeTruthy();
  });

  it('distinguishes a load failure from a missing post', async () => {
    mocks.getById.mockRejectedValue({ status: 500, message: 'boom' });

    renderAt();

    expect(await screen.findByText(/Couldn.t load/)).toBeTruthy();
    expect(screen.queryByText('Post not found')).toBeNull();
  });
});

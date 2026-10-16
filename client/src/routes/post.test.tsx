import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '@/i18n';
import { useSession } from '@/stores/session.store';
import { useUI } from '@/stores/ui.store';
import { makeComment, makePost, makeUser, makeUserLite } from '@/test/fixtures';

const mocks = vi.hoisted(() => ({
  getById: vi.fn(),
  listForPost: vi.fn(),
  createComment: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  track: vi.fn(),
}));

vi.mock('@/api/posts.api', () => ({
  getById: mocks.getById,
  update: vi.fn(),
  remove: vi.fn(),
  translate: vi.fn(),
  create: vi.fn(),
}));
vi.mock('@/api/likes.api', () => ({ likePost: vi.fn(), unlikePost: vi.fn() }));
vi.mock('@/api/bookmarks.api', () => ({ bookmarkPost: vi.fn(), unbookmarkPost: vi.fn() }));
vi.mock('@/api/comments.api', () => ({
  listForPost: mocks.listForPost,
  create: mocks.createComment,
}));
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));
vi.mock('@/lib/analytics', () => ({ track: mocks.track }));
// The real PostCard renders here: the detail page's comment thread IS the
// card's own (open by default), so the route test has to see it. Only the
// IntersectionObserver plumbing is stubbed (useInfiniteScroll has its own suite).
vi.mock('@/components/InfiniteScrollSentinel', () => ({
  InfiniteScrollSentinel: () => null,
}));

import PostRoute from './post';

const ME = makeUser({ id: 'me', username: 'me', usernameDisplay: 'me', displayName: 'Me' });

// Ids are ObjectId-shaped: the route refuses anything else before any request.
const PID = '64b7f0c2a1d3e4f5a6b7c8d9';
const POST = makePost({
  id: PID,
  text: 'The post body',
  author: makeUserLite({ id: 'u-z', username: 'zed', usernameDisplay: 'zed', displayName: 'Zed' }),
});

function renderAt(id = PID) {
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
    mocks.getById.mockResolvedValue({ ...POST, commentCount: 2 });
    mocks.listForPost.mockResolvedValue({
      items: [
        makeComment({ id: 'c-1', text: 'first comment' }),
        makeComment({ id: 'c-2', text: 'second comment' }),
      ],
      nextCursor: null,
    });

    renderAt();

    expect(await screen.findByText('The post body')).toBeTruthy();
    expect(await screen.findByText('first comment')).toBeTruthy();
    expect(await screen.findByText('second comment')).toBeTruthy();
    expect(mocks.track).toHaveBeenCalledWith('post_view', { postId: PID });
    // Comments are requested with the viewer's language for translations.
    expect(mocks.listForPost).toHaveBeenCalledWith(PID, {
      cursor: null,
      limit: 20,
      lang: 'en',
    });
  });

  it('asks for the post in the viewer language, and refetches when it changes', async () => {
    // The permalink used to send no lang at all, so an anonymous reader with a
    // 中文 UI got the English body: resolveLang has no stored preference to fall
    // back to and defaults to en.
    mocks.getById.mockResolvedValue(POST);
    renderAt();

    await screen.findByText('The post body');
    expect(mocks.getById).toHaveBeenCalledWith(PID, 'en');

    mocks.getById.mockResolvedValue({ ...POST, text: '中文正文' });
    useUI.getState().setLanguage('zh');

    await waitFor(() => expect(mocks.getById).toHaveBeenCalledWith(PID, 'zh'));
    expect(await screen.findByText('中文正文')).toBeTruthy();
  });

  it('offers a sign-in link instead of the composer when signed out', async () => {
    mocks.getById.mockResolvedValue(POST);

    const { container } = renderAt();

    await screen.findByText('The post body');
    expect(container.querySelector('a[href="/login"]')).not.toBeNull();
    expect(screen.queryByLabelText('Write a comment')).toBeNull();
  });

  it('renders exactly one comment thread with one compose box', async () => {
    // The page used to render its own thread (limit 50) under the card's
    // inline one (limit 20), both on qk.posts.comments(id, lang): two compose
    // boxes, and two page sizes fighting over one cache entry.
    useSession.setState({ user: ME, bootstrap: 'ready' });
    mocks.getById.mockResolvedValue(POST);
    mocks.listForPost.mockResolvedValue({
      items: [makeComment({ id: 'c-1', text: 'only once' })],
      nextCursor: null,
    });

    const { container } = renderAt();

    expect(await screen.findByText('only once')).toBeTruthy();
    expect(screen.getAllByText('only once')).toHaveLength(1);
    expect(container.querySelectorAll('textarea')).toHaveLength(1);
    expect(mocks.listForPost).toHaveBeenCalledTimes(1);
  });

  it('makes no request for an id that is not an ObjectId', async () => {
    // React Router decodes %2F, so `/p/..%2Fusers%2Fx` hands the route
    // `../users/x`. It must never reach an API path.
    renderAt(encodeURIComponent('../users/x/follow?'));

    expect(await screen.findByText('Post not found')).toBeTruthy();
    expect(mocks.getById).not.toHaveBeenCalled();
    expect(mocks.listForPost).not.toHaveBeenCalled();
    expect(mocks.track).not.toHaveBeenCalled();
  });

  it('submits a comment and clears the box', async () => {
    useSession.setState({ user: ME, bootstrap: 'ready' });
    mocks.getById.mockResolvedValue(POST);
    mocks.createComment.mockResolvedValue(makeComment({ id: 'c-9', text: 'Nice thread' }));

    renderAt();

    const box = (await screen.findByLabelText('Write a comment')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Nice thread' } });
    const form = box.closest('form') as HTMLElement;
    fireEvent.submit(form);

    await waitFor(() =>
      expect(mocks.createComment).toHaveBeenCalledWith(PID, { text: 'Nice thread' }),
    );
    await waitFor(() => expect(box.value).toBe(''));
  });

  it('does not submit a whitespace-only comment', async () => {
    useSession.setState({ user: ME, bootstrap: 'ready' });
    mocks.getById.mockResolvedValue(POST);

    renderAt();

    const box = (await screen.findByLabelText('Write a comment')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '   ' } });
    fireEvent.submit(box.closest('form') as HTMLElement);

    expect(mocks.createComment).not.toHaveBeenCalled();
  });

  it('shows the not-found state on 404 and routes back to /global signed out', async () => {
    mocks.getById.mockRejectedValue({ status: 404, message: 'Post not found' });

    renderAt('64b7f0c2a1d3e4f5a6b7c8d0');

    expect(await screen.findByText('Post not found')).toBeTruthy();
    expect(screen.getByText('This post may have been removed or is private.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button'));
    expect(await screen.findByText('GLOBAL-DEST')).toBeTruthy();
  });

  it('routes back to /feed on 404 when signed in', async () => {
    useSession.setState({ user: ME, bootstrap: 'ready' });
    mocks.getById.mockRejectedValue({ status: 404, message: 'Post not found' });

    renderAt('64b7f0c2a1d3e4f5a6b7c8d0');

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

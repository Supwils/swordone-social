import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactElement } from 'react';
import '@/i18n';
import type { PostDTO, UserLiteDTO } from '@/api/types';

vi.mock('@/api/likes.api', () => ({ likePost: vi.fn(), unlikePost: vi.fn() }));
vi.mock('@/api/posts.api', () => ({ update: vi.fn(), remove: vi.fn(), translate: vi.fn() }));
vi.mock('@/api/bookmarks.api', () => ({ bookmarkPost: vi.fn(), unbookmarkPost: vi.fn() }));

import * as postsApi from '@/api/posts.api';
import { PostCard } from './PostCard';

function author(over: Partial<UserLiteDTO> = {}): UserLiteDTO {
  return {
    id: 'u-qiusai',
    username: 'qiusai',
    usernameDisplay: 'qiusai',
    displayName: '球赛',
    avatarUrl: null,
    headline: '',
    profileTags: [],
    isAgent: true,
    ...over,
  };
}

function post(over: Partial<PostDTO> = {}): PostDTO {
  return {
    id: 'p-basil',
    author: author(),
    text: '罗勒掐顶之后侧芽会更快。',
    images: [],
    video: null,
    tags: [{ slug: 'garden', display: 'garden' }],
    mentions: [],
    visibility: 'public',
    likeCount: 3,
    commentCount: 1,
    echoCount: 0,
    likedByMe: false,
    bookmarkedByMe: false,
    createdAt: '2026-08-20T08:00:00.000Z',
    editedAt: null,
    ...over,
  };
}

function renderCard(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe('PostCard', () => {
  it('renders the author, body, and agent badge', () => {
    renderCard(<PostCard post={post()} />);

    expect(screen.getByText('球赛')).toBeTruthy();
    expect(screen.getByText('罗勒掐顶之后侧芽会更快。')).toBeTruthy();
    expect(screen.getByText('AI')).toBeTruthy();
    expect(screen.getByText('garden')).toBeTruthy();
  });

  it('offers read-more on compact cards and not on the reading-column card', () => {
    const { unmount } = renderCard(<PostCard post={post()} compact />);
    expect(screen.getByRole('button', { name: 'Read more' })).toBeTruthy();
    unmount();

    renderCard(<PostCard post={post()} />);
    expect(screen.queryByRole('button', { name: 'Read more' })).toBeNull();
  });

  it('does not show the AI badge for a non-agent author', () => {
    renderCard(
      <PostCard post={post({ author: author({ isAgent: false, displayName: '绿窗' }) })} />,
    );

    expect(screen.getByText('绿窗')).toBeTruthy();
    expect(screen.queryByText('AI')).toBeNull();
  });

  it('shows the original text, not the translation, when toggled', () => {
    renderCard(
      <PostCard
        post={post({
          text: 'the basil pinch',
          originalText: '罗勒掐顶原文',
          originalLang: 'zh',
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /original/i }));
    expect(screen.getByText('罗勒掐顶原文')).toBeTruthy();
    expect(screen.queryByText('the basil pinch')).toBeNull();
  });

  it('does not nest a hashtag link inside another anchor', () => {
    const { container } = renderCard(
      <PostCard post={post({ text: 'pinch the basil #garden' })} compact />,
    );
    const inline = container.querySelector('p a[href="/tag/garden"]');
    expect(inline).toBeTruthy();
    expect(inline?.parentElement?.closest('a')).toBeNull();
  });

  it('navigates to the post when the body is clicked', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <Routes>
            <Route path="/" element={<PostCard post={post()} compact />} />
            <Route path="/p/:id" element={<div>opened</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText('罗勒掐顶之后侧芽会更快。'));
    expect(screen.getByText('opened')).toBeTruthy();
  });

  it('follows a hashtag instead of opening the post', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <Routes>
            <Route
              path="/"
              element={<PostCard post={post({ text: 'pinch the basil #garden' })} compact />}
            />
            <Route path="/p/:id" element={<div>opened-post</div>} />
            <Route path="/tag/:slug" element={<div>opened-tag</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const inline = document.querySelector('p a[href="/tag/garden"]');
    expect(inline).toBeTruthy();
    fireEvent.click(inline!);
    expect(screen.getByText('opened-tag')).toBeTruthy();
    expect(screen.queryByText('opened-post')).toBeNull();
  });

  it('does not navigate when the video control surface is clicked', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <Routes>
            <Route
              path="/"
              element={
                <PostCard
                  post={post({ video: { url: 'https://cdn.example/v.mp4', width: 16, height: 9 } })}
                  compact
                />
              }
            />
            <Route path="/p/:id" element={<div>opened-post</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const video = container.querySelector('video');
    expect(video).toBeTruthy();
    fireEvent.click(video!);
    expect(screen.queryByText('opened-post')).toBeNull();
  });

  it('opens the post when Enter is pressed on the card itself', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <Routes>
            <Route path="/" element={<PostCard post={post()} compact />} />
            <Route path="/p/:id" element={<div>opened</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.keyDown(container.querySelector('article')!, { key: 'Enter' });
    expect(screen.getByText('opened')).toBeTruthy();
  });

  it('keeps the collapsed comment panel out of the tab order', () => {
    // The panel is always mounted and collapses with `grid-template-rows: 0fr`
    // + `overflow: hidden` — clipped, not removed. With only `aria-hidden` on
    // it, every closed panel in a feed left its controls focusable inside an
    // aria-hidden subtree (axe `aria-hidden-focus`): keyboard focus vanished
    // into invisible comment controls, once per card.
    //
    // jsdom does not implement `inert`'s focus semantics, so this pins the
    // attribute and the presence of the content it has to cover.
    const { container } = renderCard(<PostCard post={post()} />);

    const panel = container.querySelector('[data-comments]');
    expect(panel).toBeTruthy();
    expect(panel!.querySelectorAll('a, button, textarea, input').length).toBeGreaterThan(0);
    expect(panel!.hasAttribute('inert')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Toggle comments' }));
    expect(container.querySelector('[data-comments]')!.hasAttribute('inert')).toBe(false);
  });

  it('optimistically patches the bookmark and search caches it is rendered from', async () => {
    // `patchPostInCaches` enumerated ['feed'], ['users',u,'posts'] and
    // ['posts',id]. /bookmarks reads ['bookmarks'] and Explore search reads
    // ['posts','search',q] — neither was listed, and PostCard is memo'd on
    // `post`, so on those two shipped pages the heart never filled and the
    // count never moved for the rest of the session.
    const target = post();
    const page = (p: PostDTO) => ({ pages: [{ items: [p], nextCursor: null }], pageParams: [null] });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['bookmarks'], page(target));
    qc.setQueryData(['posts', 'search', 'basil'], page(target));

    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <PostCard post={target} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Like' }));

    for (const key of [['bookmarks'], ['posts', 'search', 'basil']]) {
      const cached = qc.getQueryData<{ pages: { items: PostDTO[] }[] }>(key);
      expect(cached?.pages[0].items[0].likedByMe).toBe(true);
      expect(cached?.pages[0].items[0].likeCount).toBe(4);
    }
  });

  it('opens the post when Space is pressed on the card itself', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <Routes>
            <Route path="/" element={<PostCard post={post()} compact />} />
            <Route path="/p/:id" element={<div>opened</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.keyDown(container.querySelector('article')!, { key: ' ' });
    expect(screen.getByText('opened')).toBeTruthy();
  });

  it('does not open the post when Enter is pressed on a hashtag', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <Routes>
            <Route
              path="/"
              element={<PostCard post={post({ text: 'pinch the basil #garden' })} compact />}
            />
            <Route path="/p/:id" element={<div>opened-post</div>} />
            <Route path="/tag/:slug" element={<div>opened-tag</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const inline = document.querySelector('p a[href="/tag/garden"]');
    expect(inline).toBeTruthy();
    fireEvent.keyDown(inline!, { key: 'Enter' });
    expect(screen.queryByText('opened-post')).toBeNull();
  });

  it('does not open the post when Space is pressed on a hashtag', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <Routes>
            <Route
              path="/"
              element={<PostCard post={post({ text: 'pinch the basil #garden' })} compact />}
            />
            <Route path="/p/:id" element={<div>opened-post</div>} />
            <Route path="/tag/:slug" element={<div>opened-tag</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const inline = document.querySelector('p a[href="/tag/garden"]');
    expect(inline).toBeTruthy();
    fireEvent.keyDown(inline!, { key: ' ' });
    expect(screen.queryByText('opened-post')).toBeNull();
  });
});

describe('PostCard on-demand translation', () => {
  it('offers Translate for a body in the other language and swaps in the result', async () => {
    vi.mocked(postsApi.translate).mockResolvedValue({
      id: 'p-basil',
      from: 'zh',
      to: 'en',
      text: 'Basil branches faster once pinched.',
      translated: true,
    });
    renderCard(<PostCard post={post({ lang: 'zh' })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Translate' }));

    expect(await screen.findByText('Basil branches faster once pinched.')).toBeTruthy();
    expect(postsApi.translate).toHaveBeenCalledWith('p-basil', 'en');
    expect(screen.queryByText('罗勒掐顶之后侧芽会更快。')).toBeNull();

    // The same "see original" affordance the auto path renders.
    fireEvent.click(screen.getByRole('button', { name: /original/i }));
    expect(screen.getByText('罗勒掐顶之后侧芽会更快。')).toBeTruthy();
  });

  it('does not offer Translate when the body is already in the reader language', () => {
    renderCard(<PostCard post={post({ lang: 'en', text: 'already english' })} />);
    expect(screen.queryByRole('button', { name: 'Translate' })).toBeNull();
  });

  it('keeps the original body and re-enables the control when translation fails', async () => {
    vi.mocked(postsApi.translate).mockRejectedValue(new Error('503'));
    renderCard(<PostCard post={post({ lang: 'zh' })} />);

    const btn = screen.getByRole('button', { name: 'Translate' });
    fireEvent.click(btn);

    await waitFor(() => expect(postsApi.translate).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Translate' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(screen.getByText('罗勒掐顶之后侧芽会更快。')).toBeTruthy();
  });
});

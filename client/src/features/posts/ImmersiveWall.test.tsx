import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@/i18n';
import type { PostDTO } from '@/api/types';
import { makePost, makeUserLite } from '@/test/fixtures';

// The reader deliberately renders the real PostCard so like / bookmark /
// comment / translate are one code path. Faking it here keeps these tests
// about the wall, and pins the one prop the reader depends on.
vi.mock('./PostCard', () => ({
  PostCard: ({ post, disableNavigate }: { post: PostDTO; disableNavigate?: boolean }) => (
    <article data-testid={`reader-card-${post.id}`} data-nav={disableNavigate ? 'off' : 'on'}>
      {post.text}
    </article>
  ),
}));

vi.mock('@/components/InfiniteScrollSentinel', () => ({
  InfiniteScrollSentinel: () => <div data-testid="sentinel" />,
}));

import { ImmersiveWall } from './ImmersiveWall';

let seq = 0;

function post(over: Partial<PostDTO> = {}): PostDTO {
  seq += 1;
  return makePost({
    id: `p${seq}`,
    text: `body ${seq}`,
    createdAt: '2026-08-01T00:00:00.000Z',
    author: makeUserLite({
      id: `u${seq}`,
      username: `user${seq}`,
      usernameDisplay: `user${seq}`,
      displayName: `User ${seq}`,
    }),
    ...over,
  });
}

function renderWall(items: PostDTO[], over: Partial<Parameters<typeof ImmersiveWall>[0]> = {}) {
  const onLoadMore = vi.fn();
  const props = {
    items,
    hasNextPage: false,
    isFetchingNextPage: false,
    onLoadMore,
    ...over,
  };
  const { rerender } = render(<ImmersiveWall {...props} />);
  // Callers pass an inline onLoadMore, so re-rendering with a fresh identity is
  // what the real feed does on every state change.
  return { onLoadMore, bump: () => rerender(<ImmersiveWall {...props} onLoadMore={onLoadMore} />) };
}

afterEach(() => {
  cleanup();
});

describe('ImmersiveWall', () => {
  it('lays every post out as a card and keeps the feed sentinel', () => {
    const a = post({ text: 'first note' });
    const b = post({ text: 'second note' });
    renderWall([a, b]);

    expect(screen.getByTestId('feed-immersive')).toBeTruthy();
    expect(screen.getByTestId(`immersive-card-${a.id}`)).toBeTruthy();
    expect(screen.getByTestId(`immersive-card-${b.id}`)).toBeTruthy();
    expect(screen.getByTestId('sentinel')).toBeTruthy();
    // Nothing is open until a card is chosen.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the teaser as prose, not as markdown source', () => {
    const p = post({ text: '## Heading\n\n**bold** and `code` and [a link](https://x.test)' });
    renderWall([p]);

    const card = screen.getByTestId(`immersive-card-${p.id}`);
    expect(card.textContent).toContain('Heading bold and code and a link');
    expect(card.textContent).not.toContain('##');
    expect(card.textContent).not.toContain('https://x.test');
    // The label replaces the content as the accessible name, so it has to
    // carry the gist as well as the action.
    expect(card.getAttribute('aria-label')).toContain('Heading bold and code');
  });

  it('opens the chosen post in a reader whose card cannot route away', () => {
    const a = post();
    const b = post();
    renderWall([a, b]);

    fireEvent.click(screen.getByTestId(`immersive-card-${b.id}`));

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByTestId(`reader-card-${b.id}`).getAttribute('data-nav')).toBe('off');
    expect(screen.getByText('2 of 2')).toBeTruthy();
  });

  it('walks the wall with the arrow keys and bounds the ends', () => {
    const [a, b, c] = [post(), post(), post()];
    renderWall([a, b, c]);

    fireEvent.click(screen.getByTestId(`immersive-card-${a.id}`));
    expect(screen.getByRole('button', { name: 'Previous post' }).hasAttribute('disabled')).toBe(
      true,
    );

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByTestId(`reader-card-${b.id}`)).toBeTruthy();
    expect(screen.getByText('2 of 3')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByTestId(`reader-card-${c.id}`)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next post' }).hasAttribute('disabled')).toBe(true);

    // Past the end is a no-op, not a crash or a blank reader.
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByTestId(`reader-card-${c.id}`)).toBeTruthy();

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.getByTestId(`reader-card-${b.id}`)).toBeTruthy();
  });

  it('steps with the nav buttons too', () => {
    const [a, b] = [post(), post()];
    renderWall([a, b]);

    fireEvent.click(screen.getByTestId(`immersive-card-${a.id}`));
    fireEvent.click(screen.getByRole('button', { name: 'Next post' }));
    expect(screen.getByTestId(`reader-card-${b.id}`)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Previous post' }));
    expect(screen.getByTestId(`reader-card-${a.id}`)).toBeTruthy();
  });

  it('leaves the arrow keys to a caret inside the inline composer', () => {
    const [a, b] = [post(), post()];
    renderWall([a, b]);
    fireEvent.click(screen.getByTestId(`immersive-card-${a.id}`));

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    fireEvent.keyDown(textarea, { key: 'ArrowRight' });

    expect(screen.getByTestId(`reader-card-${a.id}`)).toBeTruthy();
    textarea.remove();
  });

  it('closes the reader from its close button', () => {
    const p = post();
    renderWall([p]);

    fireEvent.click(screen.getByTestId(`immersive-card-${p.id}`));
    fireEvent.click(screen.getByRole('button', { name: 'Close reader' }));

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('pulls the next page in when the reader nears the end of what is loaded', () => {
    const items = [post(), post(), post(), post()];
    const { onLoadMore } = renderWall(items, { hasNextPage: true });

    // Opening near the front must not page: the wall is not short on posts yet.
    fireEvent.click(screen.getByTestId(`immersive-card-${items[0].id}`));
    expect(onLoadMore).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(onLoadMore).toHaveBeenCalled();
  });

  it('asks for that page once, not once per re-render', () => {
    const items = [post(), post(), post(), post()];
    const { onLoadMore, bump } = renderWall(items, { hasNextPage: true });

    fireEvent.click(screen.getByTestId(`immersive-card-${items[3].id}`));
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    bump();
    bump();
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('does not page while a page is already in flight', () => {
    const items = [post(), post()];
    const { onLoadMore } = renderWall(items, { hasNextPage: true, isFetchingNextPage: true });

    fireEvent.click(screen.getByTestId(`immersive-card-${items[1].id}`));
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('keeps the open post when a refetch reorders the list', () => {
    // The reader tracked an index: a refetch that put a new post first swapped
    // the post under the reader.
    const a = post({ text: 'alpha' });
    const b = post({ text: 'beta' });
    const fresh = post({ text: 'brand new' });
    const props = { hasNextPage: false, isFetchingNextPage: false, onLoadMore: vi.fn() };
    const { rerender } = render(<ImmersiveWall items={[a, b]} {...props} />);

    fireEvent.click(screen.getByTestId(`immersive-card-${b.id}`));
    expect(screen.getByTestId(`reader-card-${b.id}`)).toBeTruthy();

    rerender(<ImmersiveWall items={[fresh, a, b]} {...props} />);
    expect(screen.getByTestId(`reader-card-${b.id}`)).toBeTruthy();
    expect(screen.queryByTestId(`reader-card-${a.id}`)).toBeNull();
  });

  it('closes the reader when the open post leaves the list', () => {
    const a = post({ text: 'alpha' });
    const b = post({ text: 'beta' });
    const props = { hasNextPage: false, isFetchingNextPage: false, onLoadMore: vi.fn() };
    const { rerender } = render(<ImmersiveWall items={[a, b]} {...props} />);

    fireEvent.click(screen.getByTestId(`immersive-card-${b.id}`));
    rerender(<ImmersiveWall items={[a]} {...props} />);

    expect(screen.queryByTestId(`reader-card-${b.id}`)).toBeNull();
    expect(screen.queryByTestId(`reader-card-${a.id}`)).toBeNull();
    // It stays closed if the post comes back.
    rerender(<ImmersiveWall items={[a, b]} {...props} />);
    expect(screen.queryByTestId(`reader-card-${b.id}`)).toBeNull();
  });
});

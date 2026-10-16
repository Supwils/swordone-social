import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import '@/i18n';
import { qk } from '@/api/queryKeys';
import type { PostDTO } from '@/api/types';
import { useSession } from '@/stores/session.store';
import { useDrafts } from '@/stores/draft.store';
import { makeComment, makePost, makeUser, makeUserLite } from '@/test/fixtures';

const mocks = vi.hoisted(() => ({
  listForPost: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  translate: vi.fn(),
}));

vi.mock('@/api/comments.api', () => mocks);
vi.mock('@/components/InfiniteScrollSentinel', () => ({ InfiniteScrollSentinel: () => null }));

import { InlineComments } from './InlineComments';

const PID = '64b7f0c2a1d3e4f5a6b7c8d9';
const ME = makeUser({ id: 'u-me', username: 'me' });

function renderPanel(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <InlineComments postId={PID} open />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return qc;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useSession.setState({ user: null });
  useDrafts.setState({ drafts: {} });
});

describe('InlineComments', () => {
  it('edits the original text of an own comment that arrived translated', async () => {
    // The server translates the viewer's own comments too; prefilling c.text
    // saved the machine translation over what was written.
    useSession.setState({ user: ME });
    mocks.listForPost.mockResolvedValue({
      items: [
        makeComment({
          id: 'c-1',
          author: makeUserLite({ id: ME.id, username: 'me' }),
          text: 'The basil is doing well.',
          originalText: '罗勒长得不错。',
          lang: 'zh',
        }),
      ],
      nextCursor: null,
    });

    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Comment options' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    const boxes = screen.getAllByRole('textbox') as HTMLTextAreaElement[];
    expect(boxes.map((b) => b.value)).toContain('罗勒长得不错。');
    expect(boxes.map((b) => b.value)).not.toContain('The basil is doing well.');
  });

  it('moves the detail page comment count when a comment is posted', async () => {
    // Only the feed and profile lists were bumped; /p/:id kept the old count.
    useSession.setState({ user: ME });
    mocks.listForPost.mockResolvedValue({ items: [], nextCursor: null });
    mocks.create.mockResolvedValue(makeComment({ id: 'c-9' }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData<PostDTO>(qk.posts.byId(PID, 'en'), makePost({ id: PID, commentCount: 2 }));

    renderPanel(qc);

    const box = await screen.findByLabelText('Write a comment');
    fireEvent.change(box, { target: { value: 'hello' } });
    fireEvent.submit(box.closest('form') as HTMLElement);

    await waitFor(() =>
      expect(qc.getQueryData<PostDTO>(qk.posts.byId(PID, 'en'))?.commentCount).toBe(3),
    );
  });

  it('does not touch storage for an empty comment box on mount', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    mocks.listForPost.mockResolvedValue({ items: [], nextCursor: null });
    useSession.setState({ user: ME });

    renderPanel();

    expect(setItem.mock.calls.filter(([key]) => key === 'swil.drafts')).toHaveLength(0);
    setItem.mockRestore();
  });
});

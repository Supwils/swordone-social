import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';
import { useDrafts } from '@/stores/draft.store';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/api/posts.api', () => ({ create: mocks.create }));
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));
// Autocomplete has its own suite (useAutocomplete.test.ts); the composer tests
// pin composing, drafts, attachments and formatting, not mention lookup.
vi.mock('./useAutocomplete', () => ({
  useAutocomplete: () => ({ trigger: null, results: [] }),
  applySelection: vi.fn(),
}));

import { PostComposer } from './PostComposer';

function renderComposer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PostComposer />
    </QueryClientProvider>,
  );
}

function textbox(): HTMLTextAreaElement {
  return screen.getByLabelText('Post text') as HTMLTextAreaElement;
}

function postButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /^Post/ }) as HTMLButtonElement;
}

function imageFile(name = 'a.png'): File {
  return new File(['x'], name, { type: 'image/png' });
}

beforeEach(() => {
  localStorage.clear();
  useDrafts.setState({ drafts: {} });
  // jsdom has no object URLs; the previews need both ends stubbed.
  URL.createObjectURL = vi.fn(() => `blob:mock-${Math.random()}`);
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PostComposer', () => {
  it('disables Post until there is content, then posts and clears', async () => {
    mocks.create.mockResolvedValue({ id: 'p-1' });
    renderComposer();

    expect(postButton().disabled).toBe(true);

    fireEvent.change(textbox(), { target: { value: 'hello world' } });
    expect(postButton().disabled).toBe(false);

    fireEvent.click(postButton());

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        text: 'hello world',
        visibility: 'public',
        images: [],
        video: null,
      }),
    );
    await waitFor(() => expect(textbox().value).toBe(''));
    expect(mocks.toastSuccess).toHaveBeenCalled();
  });

  it('autosaves the draft, restores it on remount, and discards on demand', async () => {
    const { unmount } = renderComposer();
    fireEvent.change(textbox(), { target: { value: 'half a thought' } });

    // 600ms debounce — wait on the store, not on a sleep.
    await waitFor(
      () => expect(useDrafts.getState().getDraft('post.new')?.text).toBe('half a thought'),
      { timeout: 2000 },
    );

    unmount();
    renderComposer();
    expect(textbox().value).toBe('half a thought');

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(textbox().value).toBe('');
    await waitFor(() => expect(useDrafts.getState().getDraft('post.new')).toBeUndefined());
  });

  it('clears the stored draft when the text is emptied', async () => {
    renderComposer();
    fireEvent.change(textbox(), { target: { value: 'temp' } });
    await waitFor(() => expect(useDrafts.getState().getDraft('post.new')?.text).toBe('temp'), {
      timeout: 2000,
    });

    fireEvent.change(textbox(), { target: { value: '   ' } });
    await waitFor(() => expect(useDrafts.getState().getDraft('post.new')).toBeUndefined());
  });

  it('attaches at most 4 images and blocks the video button while any are set', async () => {
    const { container } = renderComposer();
    const input = container.querySelector('input[accept="image/*"]') as HTMLInputElement;

    fireEvent.change(input, {
      target: {
        files: [imageFile('1'), imageFile('2'), imageFile('3'), imageFile('4'), imageFile('5')],
      },
    });

    expect(await screen.findAllByLabelText('Remove image')).toHaveLength(4);
    expect((screen.getByLabelText('Attach video') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Attach images') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getAllByLabelText('Remove image')[0]);
    expect(screen.getAllByLabelText('Remove image')).toHaveLength(3);
    expect((screen.getByLabelText('Attach images') as HTMLButtonElement).disabled).toBe(false);
  });

  it('attaching a video previews it and blocks image attachment', async () => {
    const { container } = renderComposer();
    const input = container.querySelector(
      'input[accept="video/mp4,video/webm"]',
    ) as HTMLInputElement;

    fireEvent.change(input, {
      target: { files: [new File(['v'], 'clip.mp4', { type: 'video/mp4' })] },
    });

    expect(await screen.findByLabelText('Remove video')).toBeTruthy();
    expect(container.querySelector('video')).not.toBeNull();
    expect((screen.getByLabelText('Attach images') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByLabelText('Remove video'));
    expect(container.querySelector('video')).toBeNull();
    expect((screen.getByLabelText('Attach images') as HTMLButtonElement).disabled).toBe(false);
  });

  it('sends the selected visibility with the post', async () => {
    mocks.create.mockResolvedValue({ id: 'p-2' });
    renderComposer();

    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'followers' } });
    fireEvent.change(textbox(), { target: { value: 'for my people' } });
    fireEvent.click(postButton());

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'for my people', visibility: 'followers' }),
      ),
    );
  });

  it('inserts bold markdown around the default text from the format bar', () => {
    renderComposer();

    fireEvent.click(screen.getByLabelText('Bold'));

    expect(textbox().value).toBe('**bold text**');
  });

  it('toggles a blockquote prefix on the current line', () => {
    renderComposer();
    fireEvent.change(textbox(), { target: { value: 'a quiet line' } });

    fireEvent.click(screen.getByLabelText('Blockquote'));
    expect(textbox().value).toBe('> a quiet line');

    fireEvent.click(screen.getByLabelText('Blockquote'));
    expect(textbox().value).toBe('a quiet line');
  });

  it('surfaces an API failure as an error toast and keeps the text', async () => {
    mocks.create.mockRejectedValue({ message: 'Daily quota exceeded' });
    renderComposer();

    fireEvent.change(textbox(), { target: { value: 'too chatty' } });
    fireEvent.click(postButton());

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Daily quota exceeded'));
    expect(textbox().value).toBe('too chatty');
  });
});

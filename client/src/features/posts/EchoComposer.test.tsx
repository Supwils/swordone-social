import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import '@/i18n';
import type { PostDTO } from '@/api/types';
import { makePost, makeUserLite } from '@/test/fixtures';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/api/posts.api', () => ({ create: mocks.create }));
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import { EchoComposer } from './EchoComposer';

const ORIGINAL = makePost({
  id: 'p-echo',
  author: makeUserLite({
    id: 'u-orig',
    username: 'origina',
    usernameDisplay: 'origina',
    displayName: 'Origin Al',
  }),
  text: 'the original post',
  createdAt: '2026-08-01T00:00:00.000Z',
});

function renderEcho(post: PostDTO = ORIGINAL) {
  const onClose = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <EchoComposer post={post} open onClose={onClose} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return onClose;
}

function commentaryBox(): HTMLTextAreaElement {
  return screen.getByPlaceholderText('What do you think about this?') as HTMLTextAreaElement;
}

function echoButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Echo' }) as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('EchoComposer', () => {
  it('renders the original post preview inside the dialog', () => {
    renderEcho();

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Origin Al')).toBeTruthy();
    expect(screen.getByText('@origina')).toBeTruthy();
    expect(screen.getByText('the original post')).toBeTruthy();
  });

  it('blocks echoing until there is non-whitespace commentary', () => {
    renderEcho();

    // Empty commentary is BLOCKED: the button stays disabled.
    expect(echoButton().disabled).toBe(true);

    fireEvent.change(commentaryBox(), { target: { value: '   ' } });
    expect(echoButton().disabled).toBe(true);

    fireEvent.change(commentaryBox(), { target: { value: 'a real thought' } });
    expect(echoButton().disabled).toBe(false);
  });

  it('creates the echo with echoOf and commentary, toasts and closes on success', async () => {
    mocks.create.mockResolvedValue({ id: 'p-new' });
    const onClose = renderEcho();

    fireEvent.change(commentaryBox(), { target: { value: 'love this take' } });
    fireEvent.click(echoButton());

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        text: 'love this take',
        visibility: 'public',
        echoOf: 'p-echo',
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Echo posted');
  });

  it('sends the selected visibility with the echo', async () => {
    mocks.create.mockResolvedValue({ id: 'p-new' });
    renderEcho();

    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'followers' } });
    fireEvent.change(commentaryBox(), { target: { value: 'for my people' } });
    fireEvent.click(echoButton());

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({ visibility: 'followers', echoOf: 'p-echo' }),
      ),
    );
  });

  it('surfaces an API failure as an error toast and stays open with the text kept', async () => {
    mocks.create.mockRejectedValue({ message: 'Daily quota exceeded' });
    const onClose = renderEcho();

    fireEvent.change(commentaryBox(), { target: { value: 'too chatty' } });
    fireEvent.click(echoButton());

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Daily quota exceeded'));
    expect(onClose).not.toHaveBeenCalled();
    expect(commentaryBox().value).toBe('too chatty');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import '@/i18n';
import { useRealtime } from '@/stores/realtime.store';
import type { NotificationDTO, UserLiteDTO } from '@/api/types';
import { makeNotification, makeUserLite } from '@/test/fixtures';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  markRead: vi.fn(),
  clearAll: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/api/notifications.api', () => ({
  list: mocks.list,
  markRead: mocks.markRead,
  clearAll: mocks.clearAll,
}));
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));
vi.mock('@/components/InfiniteScrollSentinel', () => ({
  InfiniteScrollSentinel: () => null,
}));

import NotificationsRoute from './notifications';

function actor(id: string, name: string): UserLiteDTO {
  return makeUserLite({
    id,
    username: name.toLowerCase(),
    usernameDisplay: name.toLowerCase(),
    displayName: name,
  });
}

let seq = 0;
function notif(over: Partial<NotificationDTO> = {}): NotificationDTO {
  seq += 1;
  return makeNotification({
    id: `n-${seq}`,
    actor: actor(`u-${seq}`, `Actor${seq}`),
    createdAt: `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`,
    ...over,
  });
}

function renderRoute() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/notifications']}>
        <NotificationsRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  seq = 0;
  useRealtime.setState({
    connected: false,
    unreadNotifications: 5,
    unreadConversations: 0,
    newFeedPostCount: 0,
  });
  mocks.markRead.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('NotificationsRoute', () => {
  it('groups likes on the same post into one row with combined actors', async () => {
    const post = { id: 'p-1', textPreview: 'the post' };
    mocks.list.mockResolvedValue({
      items: [
        notif({ actor: actor('u-a', 'Alice'), post }),
        notif({ actor: actor('u-b', 'Bob'), post }),
        notif({ type: 'follow', actor: actor('u-c', 'Cara') }),
      ],
      nextCursor: null,
    });

    renderRoute();

    expect(await screen.findByText('Alice and Bob')).toBeTruthy();
    expect(screen.getByText('liked your post')).toBeTruthy();
    expect(screen.getByText('Cara')).toBeTruthy();
    expect(screen.getByText('started following you')).toBeTruthy();
    expect(mocks.list).toHaveBeenCalledWith({ cursor: null, limit: 30 });
  });

  it('labels a big group as "first and N others"', async () => {
    const post = { id: 'p-1', textPreview: 'popular' };
    mocks.list.mockResolvedValue({
      items: [
        notif({ actor: actor('u-a', 'Alice'), post }),
        notif({ actor: actor('u-b', 'Bob'), post }),
        notif({ actor: actor('u-c', 'Cara'), post }),
        notif({ actor: actor('u-d', 'Dan'), post }),
      ],
      nextCursor: null,
    });

    renderRoute();

    expect(await screen.findByText('Alice and 3 others')).toBeTruthy();
  });

  it('auto-marks everything read once on load and zeroes the badge', async () => {
    mocks.list.mockResolvedValue({ items: [notif()], nextCursor: null });

    renderRoute();

    await waitFor(() => expect(mocks.markRead).toHaveBeenCalledWith({ all: true }));
    expect(mocks.markRead).toHaveBeenCalledTimes(1);
    expect(useRealtime.getState().unreadNotifications).toBe(0);
  });

  it('does not auto-mark when nothing is unread, and disables Mark all read', async () => {
    mocks.list.mockResolvedValue({ items: [notif({ read: true })], nextCursor: null });

    renderRoute();

    await screen.findByText('liked your post');
    expect(mocks.markRead).not.toHaveBeenCalled();
    const btn = screen.getByRole('button', { name: 'Mark all read' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('shows the empty state', async () => {
    mocks.list.mockResolvedValue({ items: [], nextCursor: null });

    renderRoute();

    expect(await screen.findByText('Quiet.')).toBeTruthy();
    // Nothing to clear or mark.
    expect((screen.getByRole('button', { name: 'Clear all' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('reports a failed clear and keeps the confirm dialog open', async () => {
    mocks.list.mockResolvedValue({ items: [notif()], nextCursor: null });
    mocks.clearAll.mockRejectedValue({ status: 500, message: 'clear exploded' });

    renderRoute();

    await screen.findByText('liked your post');
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear all' }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('clear exploded'));
    // Nothing was cleared: the list and the dialog are both still there.
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('liked your post')).toBeTruthy();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it('clears everything after the confirm dialog', async () => {
    mocks.list.mockResolvedValue({ items: [notif()], nextCursor: null });
    mocks.clearAll.mockResolvedValue(undefined);

    renderRoute();

    await screen.findByText('liked your post');
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Clear all notifications?')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear all' }));

    await waitFor(() => expect(mocks.clearAll).toHaveBeenCalledOnce());
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Notifications cleared');
    expect(await screen.findByText('Quiet.')).toBeTruthy();
    expect(useRealtime.getState().unreadNotifications).toBe(0);
  });
});

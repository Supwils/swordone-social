import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import '@/i18n';
import { useSession } from '@/stores/session.store';
import type { UserDTO } from '@/api/types';

const mocks = vi.hoisted(() => ({
  changePassword: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/api/auth.api', () => ({
  register: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  me: vi.fn(),
  changePassword: mocks.changePassword,
}));
vi.mock('@/api/users.api', () => ({
  getByUsername: vi.fn(),
  updateMe: vi.fn(),
  browseUsers: vi.fn(),
  getPopularProfileTags: vi.fn(),
  searchUsers: vi.fn(),
  updateAvatar: vi.fn(),
}));
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));
vi.mock('@/features/agents/MyAgentsSection', () => ({
  MyAgentsSection: () => <div data-testid="my-agents" />,
}));

import SettingsRoute from './settings';

function seedUser(over: Partial<UserDTO> = {}): UserDTO {
  return {
    id: 'u-1',
    username: 'wilson',
    usernameDisplay: 'wilson',
    displayName: 'Wilson',
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
    createdAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function renderSettings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/settings']}>
        <SettingsRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function pwd() {
  return {
    current: screen.getByLabelText('Current password') as HTMLInputElement,
    next: screen.getByLabelText('New password') as HTMLInputElement,
    confirm: screen.getByLabelText('Confirm new password') as HTMLInputElement,
  };
}

function submitPwd() {
  fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
}

beforeEach(() => {
  useSession.setState({ user: seedUser(), bootstrap: 'ready' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useSession.setState({ user: null });
});

describe('SettingsRoute — change password card', () => {
  it('changes the password with the right payload, toasts and clears the fields', async () => {
    mocks.changePassword.mockResolvedValue(undefined);
    renderSettings();

    const f = pwd();
    fireEvent.change(f.current, { target: { value: 'old-secret-1' } });
    fireEvent.change(f.next, { target: { value: 'new-secret-12' } });
    fireEvent.change(f.confirm, { target: { value: 'new-secret-12' } });
    submitPwd();

    // confirmPassword is client-side only; the API payload must not carry it.
    await waitFor(() =>
      expect(mocks.changePassword).toHaveBeenCalledWith({
        currentPassword: 'old-secret-1',
        newPassword: 'new-secret-12',
      }),
    );
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith('Password changed'));
    await waitFor(() => expect(pwd().current.value).toBe(''));
    expect(pwd().next.value).toBe('');
    expect(pwd().confirm.value).toBe('');
  });

  it('rejects a mismatched confirmation without calling the API', async () => {
    renderSettings();

    const f = pwd();
    fireEvent.change(f.current, { target: { value: 'old-secret-1' } });
    fireEvent.change(f.next, { target: { value: 'new-secret-12' } });
    fireEvent.change(f.confirm, { target: { value: 'something-else' } });
    submitPwd();

    expect(await screen.findByText("Passwords don't match")).toBeTruthy();
    expect(mocks.changePassword).not.toHaveBeenCalled();
  });

  it('rejects a new password shorter than 8 characters', async () => {
    renderSettings();

    const f = pwd();
    fireEvent.change(f.current, { target: { value: 'old-secret-1' } });
    fireEvent.change(f.next, { target: { value: 'short1' } });
    fireEvent.change(f.confirm, { target: { value: 'short1' } });
    submitPwd();

    // The hint says "At least 8 characters." (with a period); the exact-match
    // string below is the validation error, not the hint.
    expect(await screen.findByText('At least 8 characters')).toBeTruthy();
    expect(mocks.changePassword).not.toHaveBeenCalled();
  });

  it('requires the current and confirm fields on an empty submit', async () => {
    renderSettings();

    submitPwd();

    // current + confirm are min(1) "required"; the empty new password trips
    // the min(8) length message instead.
    expect(await screen.findAllByText('This field is required')).toHaveLength(2);
    expect(screen.getByText('At least 8 characters')).toBeTruthy();
    expect(mocks.changePassword).not.toHaveBeenCalled();
  });

  it('surfaces an API failure as an error toast and keeps the fields', async () => {
    mocks.changePassword.mockRejectedValue({ message: 'Current password is incorrect' });
    renderSettings();

    const f = pwd();
    fireEvent.change(f.current, { target: { value: 'wrong-secret' } });
    fireEvent.change(f.next, { target: { value: 'new-secret-12' } });
    fireEvent.change(f.confirm, { target: { value: 'new-secret-12' } });
    submitPwd();

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('Current password is incorrect'),
    );
    expect(pwd().current.value).toBe('wrong-secret');
    expect(pwd().next.value).toBe('new-secret-12');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import '@/i18n';
import type { UserDTO } from '@/api/types';

vi.mock('@/api/users.api', () => ({ updateMe: vi.fn(), updateAvatar: vi.fn() }));
vi.mock('@/api/auth.api', () => ({ changePassword: vi.fn() }));
vi.mock('@/features/agents/MyAgentsSection', () => ({
  MyAgentsSection: () => <div data-testid="my-agents" />,
}));

import * as usersApi from '@/api/users.api';
import { useSession } from '@/stores/session.store';
import SettingsRoute from './settings';

function seedUser(over: Partial<UserDTO> = {}): UserDTO {
  return {
    id: 'u-1',
    username: 'qiusai',
    usernameDisplay: 'qiusai',
    displayName: '球赛',
    bio: 'server bio',
    headline: 'server headline',
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useSession.setState({ user: null });
});

describe('SettingsRoute', () => {
  it('keeps unsaved profile edits when an avatar upload replaces the session user', async () => {
    // The seeding effect keyed on the whole `user` object, and
    // `avatar.onSuccess` publishes `{ ...user, avatarUrl }` — a new identity.
    // So uploading an avatar mid-edit silently reverted the typed bio to the
    // server value, with no warning and no way to get the text back.
    useSession.setState({ user: seedUser() });
    vi.mocked(usersApi.updateAvatar).mockResolvedValue('https://cdn.example.com/a.webp');

    renderSettings();

    const bio = (await screen.findByDisplayValue('server bio')) as HTMLTextAreaElement;
    fireEvent.change(bio, { target: { value: 'a draft I have not saved' } });

    const file = new File(['x'], 'a.png', { type: 'image/png' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() =>
      expect(useSession.getState().user?.avatarUrl).toBe('https://cdn.example.com/a.webp'),
    );
    expect(bio.value).toBe('a draft I have not saved');
  });

  it('reseeds the form when the signed-in account itself changes', async () => {
    useSession.setState({ user: seedUser() });
    renderSettings();

    await screen.findByDisplayValue('server bio');
    useSession.setState({ user: seedUser({ id: 'u-2', bio: 'another account' }) });

    expect(await screen.findByDisplayValue('another account')).toBeTruthy();
  });
});

describe('SettingsRoute auto-translate preference', () => {
  const prefs = {
    theme: 'system' as const,
    language: 'en' as const,
    emailNotifications: true,
    pushNotifications: true,
  };

  it('reads as On by default and persists Off through PATCH /users/me', async () => {
    const user = seedUser({ preferences: prefs });
    useSession.setState({ user, bootstrap: 'ready' });
    vi.mocked(usersApi.updateMe).mockResolvedValue(
      seedUser({ preferences: { ...prefs, autoTranslate: false } }),
    );
    renderSettings();

    expect(screen.getByRole('button', { name: 'On' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Off' }));

    await waitFor(() =>
      expect(usersApi.updateMe).toHaveBeenCalledWith({ preferences: { autoTranslate: false } }),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Off' }).getAttribute('aria-pressed')).toBe('true'),
    );
    expect(useSession.getState().user?.preferences?.autoTranslate).toBe(false);
  });

  it('leaves the preference untouched when the save fails', async () => {
    useSession.setState({ user: seedUser({ preferences: prefs }), bootstrap: 'ready' });
    vi.mocked(usersApi.updateMe).mockRejectedValue(new Error('offline'));
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Off' }));

    await waitFor(() => expect(usersApi.updateMe).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'On' }).getAttribute('aria-pressed')).toBe('true');
  });
});

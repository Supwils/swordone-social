import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import '@/i18n';
import type { UserLiteDTO } from '@/api/types';

const mocks = vi.hoisted(() => ({
  getPopularProfileTags: vi.fn(),
  browseUsers: vi.fn(),
}));
vi.mock('@/api/users.api', () => ({
  getPopularProfileTags: mocks.getPopularProfileTags,
  browseUsers: mocks.browseUsers,
}));

import { ExplorePeopleTab } from './ExplorePeopleTab';

function lite(username: string, isAgent: boolean): UserLiteDTO {
  return {
    id: `u-${username}`,
    username,
    usernameDisplay: username,
    displayName: username.toUpperCase(),
    avatarUrl: null,
    headline: '',
    profileTags: [],
    isAgent,
  };
}

function renderTab(url = '/explore?tab=people') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <ExplorePeopleTab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.getPopularProfileTags.mockResolvedValue([{ tag: 'compilers', count: 3 }]);
  mocks.browseUsers.mockResolvedValue([lite('hana', false), lite('gewu', true)]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ExplorePeopleTab', () => {
  it('browses the directory untagged by default and renders both cohorts', async () => {
    renderTab();

    expect(await screen.findByText('HANA')).toBeTruthy();
    expect(screen.getByText('GEWU')).toBeTruthy();
    // Only the agent card carries the AI badge.
    expect(screen.getAllByText('AI')).toHaveLength(1);
    expect(mocks.browseUsers).toHaveBeenCalledWith(40, undefined, expect.anything());
  });

  it('re-queries with the tag when a filter pill is picked', async () => {
    renderTab();
    await screen.findByText('HANA');

    const all = screen.getByRole('button', { name: 'All' });
    const pill = screen.getByRole('button', { name: 'compilers' });
    expect(all.getAttribute('aria-pressed')).toBe('true');
    expect(pill.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(pill);

    await waitFor(() =>
      expect(mocks.browseUsers).toHaveBeenCalledWith(40, 'compilers', expect.anything()),
    );
    expect(pill.getAttribute('aria-pressed')).toBe('true');
    expect(all.getAttribute('aria-pressed')).toBe('false');
  });

  it('honours a ?tag= already in the URL', async () => {
    renderTab('/explore?tab=people&tag=compilers');

    await waitFor(() =>
      expect(mocks.browseUsers).toHaveBeenCalledWith(40, 'compilers', expect.anything()),
    );
  });

  it('filters to agents client-side, with its own empty message', async () => {
    renderTab();
    await screen.findByText('HANA');

    const toggle = screen.getByRole('button', { name: 'Agents only' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByText('HANA')).toBeNull();
    expect(screen.getByText('GEWU')).toBeTruthy();

    // With no agents at all the toggle shows the agent-specific empty state.
    mocks.browseUsers.mockResolvedValue([lite('solo', false)]);
    cleanup();
    renderTab();
    await screen.findByText('SOLO');
    fireEvent.click(screen.getByRole('button', { name: 'Agents only' }));
    expect(screen.getByText('No agents with that tag yet.')).toBeTruthy();
  });

  it('shows the generic empty state when the directory is empty', async () => {
    mocks.browseUsers.mockResolvedValue([]);

    renderTab();

    expect(await screen.findByText('No one here yet with that tag.')).toBeTruthy();
  });
});

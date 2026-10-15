import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import '@/i18n';
import { useUI } from '@/stores/ui.store';
import { useSession } from '@/stores/session.store';
import { makeUser } from '@/test/fixtures';

const mocks = vi.hoisted(() => ({ searchUsers: vi.fn() }));
vi.mock('@/api/users.api', () => ({ searchUsers: mocks.searchUsers }));

import { CommandPalette } from './CommandPalette';

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function renderPalette() {
  return render(
    <MemoryRouter initialEntries={['/feed']}>
      <CommandPalette />
      <LocationProbe />
    </MemoryRouter>,
  );
}

function openPalette() {
  fireEvent.keyDown(window, { key: 'k', metaKey: true });
  return screen.getByLabelText('Type a command or search people…');
}

beforeEach(() => {
  useUI.setState({
    cmdkOpen: false,
    theme: 'system',
    language: 'en',
    feedLayout: 'grid',
    sidebarCollapsed: false,
  });
  useSession.setState({
    user: makeUser({ id: 'u-me', username: 'me', usernameDisplay: 'me' }),
    bootstrap: 'ready',
  });
  mocks.searchUsers.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CommandPalette', () => {
  it('opens on ⌘K, closes on Escape, and toggles on a second ⌘K', () => {
    renderPalette();
    expect(screen.queryByRole('dialog')).toBeNull();

    const input = openPalette();
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useUI.getState().cmdkOpen).toBe(false);

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('filters commands and runs the selection on Enter', () => {
    renderPalette();
    const input = openPalette();

    fireEvent.change(input, { target: { value: 'Global' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByTestId('loc').textContent).toBe('/global');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('moves the selection with the arrow keys', () => {
    renderPalette();
    const input = openPalette();

    // Signed in: item 0 is Following (/feed), item 1 is Global (/global).
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByTestId('loc').textContent).toBe('/global');
  });

  it('sets the theme through a preference command', () => {
    renderPalette();
    const input = openPalette();

    fireEvent.change(input, { target: { value: 'dark' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(useUI.getState().theme).toBe('dark');
  });

  it('offers the reading-column layout while in the grid, and switches to it', () => {
    renderPalette();
    const input = openPalette();

    fireEvent.change(input, { target: { value: 'reading column' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(useUI.getState().feedLayout).toBe('list');
  });

  it('reaches the immersive wall, and stops offering the layout already in effect', () => {
    renderPalette();
    const input = openPalette();

    fireEvent.change(input, { target: { value: 'immersive wall' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(useUI.getState().feedLayout).toBe('immersive');

    const reopened = openPalette();
    fireEvent.change(reopened, { target: { value: 'Feed layout' } });
    expect(screen.queryByText('Feed layout: immersive wall')).toBeNull();
    expect(screen.getByText('Feed layout: folio grid')).toBeTruthy();
  });

  it('hides authed commands for anonymous visitors', () => {
    useSession.setState({ user: null, bootstrap: 'ready' });
    renderPalette();
    openPalette();

    expect(screen.queryByText('Notifications')).toBeNull();
    expect(screen.queryByText('Bookmarks')).toBeNull();
    expect(screen.getByText('Global')).toBeTruthy();
  });

  it('searches people after a 2+ char query and navigates to the profile', async () => {
    mocks.searchUsers.mockResolvedValue([
      {
        id: 'u-a',
        username: 'alice',
        usernameDisplay: 'alice',
        displayName: 'Alice',
        avatarUrl: null,
        headline: '',
        profileTags: [],
        isAgent: false,
      },
    ]);
    renderPalette();
    const input = openPalette();

    fireEvent.change(input, { target: { value: 'ali' } });

    await waitFor(() => expect(mocks.searchUsers).toHaveBeenCalledWith('ali'));
    const option = await screen.findByText('Alice — @alice');
    fireEvent.mouseDown(option.closest('button') as HTMLElement);

    expect(screen.getByTestId('loc').textContent).toBe('/u/alice');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the empty hint when nothing matches', () => {
    renderPalette();
    const input = openPalette();

    fireEvent.change(input, { target: { value: 'zzzzzz' } });

    expect(screen.getByText('No matches.')).toBeTruthy();
  });
});

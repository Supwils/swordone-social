import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@/i18n';
import { useUI } from '@/stores/ui.store';
import { FeedLayoutToggle } from './FeedLayoutToggle';

afterEach(() => {
  cleanup();
  useUI.setState({ feedLayout: 'grid' });
  localStorage.removeItem('swil.ui');
});

describe('FeedLayoutToggle', () => {
  it('defaults to folio pressed and switches the shared layout', () => {
    render(<FeedLayoutToggle />);

    const group = screen.getByRole('group', { name: 'Feed layout' });
    expect(group).toBeTruthy();

    const folio = screen.getByRole('button', { name: 'Two posts in view' });
    const list = screen.getByRole('button', { name: 'Reading column' });
    expect(folio.getAttribute('aria-pressed')).toBe('true');
    expect(list.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(list);
    expect(useUI.getState().feedLayout).toBe('list');
    expect(list.getAttribute('aria-pressed')).toBe('true');
    expect(folio.getAttribute('aria-pressed')).toBe('false');
  });

  it('switches to the immersive wall and leaves the other two unpressed', () => {
    render(<FeedLayoutToggle />);

    const immersive = screen.getByRole('button', { name: 'Immersive wall' });
    fireEvent.click(immersive);

    expect(useUI.getState().feedLayout).toBe('immersive');
    expect(immersive.getAttribute('aria-pressed')).toBe('true');
    expect(
      screen.getByRole('button', { name: 'Two posts in view' }).getAttribute('aria-pressed'),
    ).toBe('false');
    expect(
      screen.getByRole('button', { name: 'Reading column' }).getAttribute('aria-pressed'),
    ).toBe('false');
  });
});

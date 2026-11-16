import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@/i18n';
import { GuestBanner } from './GuestBanner';

afterEach(cleanup);

describe('GuestBanner', () => {
  it('offers both ways in and can be dismissed', () => {
    const onDismiss = vi.fn();
    render(
      <MemoryRouter initialEntries={['/lab']}>
        <GuestBanner onDismiss={onDismiss} />
      </MemoryRouter>,
    );

    const banner = screen.getByRole('complementary', { name: 'Guest notice' });
    expect(banner.textContent).toContain("You're reading as a guest");
    expect(screen.getByRole('link', { name: 'Join' }).getAttribute('href')).toBe('/register');
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

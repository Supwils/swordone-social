import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import '@/i18n';
import { useAuthPrompt } from '@/stores/authPrompt.store';
import { SignInPrompt } from './SignInPrompt';

function LoginProbe() {
  const loc = useLocation();
  return <div>LOGIN from={(loc.state as { from?: string } | null)?.from}</div>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SignInPrompt />
      <Routes>
        <Route path="/p/:id" element={<div>POST</div>} />
        <Route path="/login" element={<LoginProbe />} />
        <Route path="/register" element={<div>REGISTER</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  useAuthPrompt.setState({ reason: null });
});

describe('SignInPrompt', () => {
  it('stays closed until a gated action opens it', () => {
    renderAt('/p/1');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('names the action and sends sign-in back to the current page', () => {
    renderAt('/p/1?ref=x');
    act(() => useAuthPrompt.getState().open('like'));

    expect(screen.getByRole('dialog', { name: 'Sign in to like this post' })).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Sign in' }));

    expect(screen.getByText('LOGIN from=/p/1?ref=x')).toBeTruthy();
    expect(useAuthPrompt.getState().reason).toBeNull();
  });

  it('closes on "Keep reading" without navigating', () => {
    renderAt('/p/1');
    act(() => useAuthPrompt.getState().open('follow'));

    fireEvent.click(screen.getByRole('button', { name: 'Keep reading' }));
    expect(useAuthPrompt.getState().reason).toBeNull();
    expect(screen.getByText('POST')).toBeTruthy();
  });
});

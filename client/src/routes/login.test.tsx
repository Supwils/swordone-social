import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '@/i18n';
import { useSession } from '@/stores/session.store';
import { makeUser } from '@/test/fixtures';

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  register: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/api/auth.api', () => ({ login: mocks.login, register: mocks.register }));
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import AuthPage from './login';

function renderAt(entry: string | { pathname: string; state?: unknown }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/login" element={<AuthPage />} />
          <Route path="/register" element={<AuthPage />} />
          <Route path="/feed" element={<div>FEED-DEST</div>} />
          <Route path="/bookmarks" element={<div>BOOKMARKS-DEST</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Both panels are always mounted (CSS slides between them), so every field
 * lookup is scoped to its own <form>. */
function loginForm(): HTMLElement {
  const form = screen.getByLabelText('Username or email').closest('form');
  expect(form).not.toBeNull();
  return form as HTMLElement;
}

function registerForm(): HTMLElement {
  const form = screen.getByLabelText('Email').closest('form');
  expect(form).not.toBeNull();
  return form as HTMLElement;
}

function fill(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

/** Controllable clock for the anti-bot minimum-fill-time check. */
let now = 1_000_000;

beforeEach(() => {
  now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  // floor(0.5 * 9) + 1 = 5 for both operands -> challenge answer is 10.
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  useSession.setState({ user: null, bootstrap: 'ready' });
});

afterEach(() => {
  cleanup();
  // restoreAllMocks only handles vi.spyOn spies (Date.now / Math.random);
  // clearAllMocks is what wipes call history off the vi.fn() module mocks.
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('AuthPage — login', () => {
  it('shows field errors on an empty submit and never calls the API', async () => {
    renderAt('/login');

    fireEvent.submit(loginForm());

    expect(await screen.findAllByText('This field is required')).toHaveLength(2);
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it('logs in, stores the session user, toasts, and navigates to /feed', async () => {
    const user = makeUser({ id: 'u1' });
    mocks.login.mockResolvedValue(user);
    renderAt('/login');

    const form = loginForm();
    fill(screen.getByLabelText('Username or email'), 'alice');
    fill(within(form).getByLabelText('Password'), 'secret-pw');
    fireEvent.submit(form);

    await waitFor(() =>
      expect(mocks.login).toHaveBeenCalledWith({
        usernameOrEmail: 'alice',
        password: 'secret-pw',
      }),
    );
    expect(await screen.findByText('FEED-DEST')).toBeTruthy();
    expect(useSession.getState().user?.id).toBe('u1');
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Welcome back, alice');
  });

  it('returns to the page the user was bounced from after login', async () => {
    mocks.login.mockResolvedValue(makeUser({ id: 'u1' }));
    renderAt({ pathname: '/login', state: { from: '/bookmarks' } });

    const form = loginForm();
    fill(screen.getByLabelText('Username or email'), 'alice');
    fill(within(form).getByLabelText('Password'), 'secret-pw');
    fireEvent.submit(form);

    expect(await screen.findByText('BOOKMARKS-DEST')).toBeTruthy();
  });

  it('surfaces the API error in the alert banner on failure', async () => {
    mocks.login.mockRejectedValue({ message: 'Invalid credentials' });
    renderAt('/login');

    const form = loginForm();
    fill(screen.getByLabelText('Username or email'), 'alice');
    fill(within(form).getByLabelText('Password'), 'wrong');
    fireEvent.submit(form);

    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toBe('Invalid credentials');
    expect(useSession.getState().user).toBeNull();
  });
});

describe('AuthPage — register', () => {
  function fillRegisterFields(form: HTMLElement) {
    fill(within(form).getByLabelText('Username'), 'newbie');
    fill(within(form).getByLabelText('Email'), 'newbie@example.com');
    fill(within(form).getByLabelText('Password'), 'password1');
  }

  /** The arithmetic challenge is reachable by its label, like every other field. */
  function challengeInput(form: HTMLElement): HTMLElement {
    return within(form).getByLabelText(/Quick check: 5 \+ 5 =/);
  }

  it('registers after the anti-bot checks pass and navigates to /feed', async () => {
    mocks.register.mockResolvedValue(makeUser({ id: 'u2', usernameDisplay: 'newbie' }));
    renderAt('/register');

    const form = registerForm();
    fillRegisterFields(form);
    fill(challengeInput(form), '10');
    now += 5_000; // slower than the 3s bot floor
    fireEvent.submit(form);

    await waitFor(() =>
      expect(mocks.register).toHaveBeenCalledWith({
        username: 'newbie',
        email: 'newbie@example.com',
        password: 'password1',
        displayName: '',
      }),
    );
    expect(await screen.findByText('FEED-DEST')).toBeTruthy();
    expect(useSession.getState().user?.id).toBe('u2');
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Welcome, newbie');
  });

  it('rejects a submission faster than a human can type', async () => {
    renderAt('/register');

    const form = registerForm();
    fillRegisterFields(form);
    fill(challengeInput(form), '10');
    // clock NOT advanced: submit lands within the 3s window
    fireEvent.submit(form);

    expect(await screen.findByText('Please take a moment to fill in the form.')).toBeTruthy();
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it('rejects a wrong arithmetic-challenge answer', async () => {
    renderAt('/register');

    const form = registerForm();
    fillRegisterFields(form);
    fill(challengeInput(form), '3');
    now += 5_000;
    fireEvent.submit(form);

    const error = await screen.findByText("Answer doesn't match — try again.");
    expect(error.getAttribute('role')).toBe('alert');
    // The error is wired to the input, not just painted next to it.
    const input = challengeInput(form);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(error.id);
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it('silently drops a submission when the honeypot field is filled', async () => {
    renderAt('/register');

    const form = registerForm();
    fillRegisterFields(form);
    fill(challengeInput(form), '10');
    const honeypot = form.querySelector('input[name="website"]');
    expect(honeypot).not.toBeNull();
    fill(honeypot as HTMLElement, 'https://spam.example');
    now += 5_000;
    fireEvent.submit(form);

    // No error surface, no API call — the bot learns nothing.
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it('enforces the username zod rules before anything else', async () => {
    renderAt('/register');

    const form = registerForm();
    fill(within(form).getByLabelText('Username'), 'ab');
    fill(within(form).getByLabelText('Email'), 'newbie@example.com');
    fill(within(form).getByLabelText('Password'), 'password1');
    fill(challengeInput(form), '10');
    now += 5_000;
    fireEvent.submit(form);

    expect(await screen.findByText('At least 3 characters')).toBeTruthy();
    expect(mocks.register).not.toHaveBeenCalled();
  });
});

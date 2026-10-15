import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useSession } from '@/stores/session.store';
import { makeUser } from '@/test/fixtures';
import { OpenRoute, ProtectedRoute, PublicRoute } from './RouteGuards';

/**
 * These guards decide what a signed-out visitor can see, which is the whole
 * point of public read mode (ADR 006): the observation lab and the global feed
 * have to be linkable without an account. The server side of that boundary is
 * asserted in server/src/modules/agents/agents.routes.test.ts; this is the
 * client half, so a future refactor cannot quietly re-gate the lab.
 */

const someUser = makeUser({ id: 'u1', username: 'ada', usernameDisplay: 'ada' });

function renderGuarded(guard: 'open' | 'protected' | 'public') {
  const Guard = guard === 'open' ? OpenRoute : guard === 'protected' ? ProtectedRoute : PublicRoute;
  return render(
    <MemoryRouter initialEntries={['/lab']}>
      <Routes>
        <Route
          path="/lab"
          element={
            <Guard>
              <div>lab content</div>
            </Guard>
          }
        />
        <Route path="/login" element={<div>login page</div>} />
        <Route path="/feed" element={<div>feed page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useSession.setState({ user: null, bootstrap: 'ready' });
});
afterEach(cleanup);

describe('OpenRoute', () => {
  it('renders for a signed-out visitor', () => {
    renderGuarded('open');
    expect(screen.getByText('lab content')).toBeTruthy();
    expect(screen.queryByText('login page')).toBeNull();
  });

  it('renders for a signed-in user too', () => {
    useSession.setState({ user: someUser, bootstrap: 'ready' });
    renderGuarded('open');
    expect(screen.getByText('lab content')).toBeTruthy();
  });

  it('waits for the auth probe instead of flashing the anonymous view', () => {
    // Rendering immediately on bootstrap==='pending' would show a signed-in
    // user the logged-out shell for one frame.
    useSession.setState({ user: null, bootstrap: 'pending' });
    renderGuarded('open');
    expect(screen.queryByText('lab content')).toBeNull();
    // getAllByRole: the gate wrapper and the Spinner inside it both carry
    // role="status", so a singular query throws on the nesting rather than
    // on the behaviour under test.
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
  });
});

describe('ProtectedRoute', () => {
  it('still bounces a signed-out visitor to /login', () => {
    renderGuarded('protected');
    expect(screen.getByText('login page')).toBeTruthy();
    expect(screen.queryByText('lab content')).toBeNull();
  });

  it('renders for a signed-in user', () => {
    useSession.setState({ user: someUser, bootstrap: 'ready' });
    renderGuarded('protected');
    expect(screen.getByText('lab content')).toBeTruthy();
  });
});

describe('PublicRoute', () => {
  it('sends an already-signed-in user away from login/register', () => {
    useSession.setState({ user: someUser, bootstrap: 'ready' });
    renderGuarded('public');
    expect(screen.getByText('feed page')).toBeTruthy();
  });
});

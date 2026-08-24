import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
// The default fallback is translated; without this the assertions below match
// raw i18n keys instead of copy.
import '@/i18n';
import { ErrorBoundary } from './ErrorBoundary';

function Bomb({ live }: { live: boolean }) {
  if (live) throw new Error('kaboom from the render');
  return <div>all calm</div>;
}

beforeEach(() => {
  // React and componentDidCatch both log the caught error; keep the run quiet.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('renders its children while nothing throws', () => {
    render(
      <ErrorBoundary>
        <Bomb live={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('all calm')).toBeTruthy();
  });

  it('catches a render error and shows the default alert with the message', () => {
    render(
      <ErrorBoundary>
        <Bomb live />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('Something broke.')).toBeTruthy();
    expect(screen.getByText('kaboom from the render')).toBeTruthy();
  });

  it('hands the error and a working reset to a custom fallback', () => {
    const { rerender } = render(
      <ErrorBoundary
        fallback={(error, reset) => (
          <button type="button" onClick={reset}>
            retry after {error.message}
          </button>
        )}
      >
        <Bomb live />
      </ErrorBoundary>,
    );

    const retry = screen.getByRole('button', { name: 'retry after kaboom from the render' });

    // Fix the child first, then reset — the boundary must re-render children.
    rerender(
      <ErrorBoundary
        fallback={(error, reset) => (
          <button type="button" onClick={reset}>
            retry after {error.message}
          </button>
        )}
      >
        <Bomb live={false} />
      </ErrorBoundary>,
    );
    fireEvent.click(retry);

    expect(screen.getByText('all calm')).toBeTruthy();
  });
});

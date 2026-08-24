import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Dialog } from './Dialog';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Dialog', () => {
  it('names the dialog by its title and describes it by its description', () => {
    render(
      <Dialog open onOpenChange={() => undefined} title="Delete this?" description="No undo.">
        <p>body</p>
      </Dialog>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Delete this?' });
    expect(dialog.getAttribute('aria-describedby')).toBe(screen.getByText('No undo.').id);
  });

  it('keeps a hidden title in the accessibility tree and out of the visible heading style', () => {
    // Radix logs a console error for a Content without a Title; the composer,
    // lightbox and post-preview dialogs used to render none at all.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <Dialog open onOpenChange={() => undefined} title="New post" titleHidden>
        <p>body</p>
      </Dialog>,
    );

    const dialog = screen.getByRole('dialog', { name: 'New post' });
    const title = screen.getByText('New post');
    expect(title.className).not.toContain('title');
    expect(title.className).toContain('srOnly');
    // No description was given, so the dialog must not point at a missing one.
    expect(dialog.hasAttribute('aria-describedby')).toBe(false);
    expect(consoleError).not.toHaveBeenCalled();
  });
});

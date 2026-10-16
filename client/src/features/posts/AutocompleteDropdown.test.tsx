import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@/i18n';
import type { AutocompleteResult } from './useAutocomplete';
import { makeTag, makeUserLite } from '@/test/fixtures';

import { AutocompleteDropdown } from './AutocompleteDropdown';

const ALICE = makeUserLite({ id: 'u-alice', displayName: 'Alice A' });
const BOB = makeUserLite({
  id: 'u-bob',
  username: 'bob',
  usernameDisplay: 'bob',
  displayName: 'Bob B',
});
const AI_TAG = makeTag({ slug: 'ai', display: 'ai', postCount: 1234 });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AutocompleteDropdown', () => {
  it('renders nothing when there are no results', () => {
    const { container } = render(
      <AutocompleteDropdown prefix="@" results={[]} activeIndex={0} onSelect={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders user results with display name and @username, and fires onSelect on click', () => {
    const onSelect = vi.fn();
    const alice = ALICE;
    const bob = BOB;

    render(
      <AutocompleteDropdown
        prefix="@"
        results={[alice, bob]}
        activeIndex={0}
        onSelect={onSelect}
      />,
    );

    expect(screen.getByText('Alice A')).toBeTruthy();
    expect(screen.getByText('@alice')).toBeTruthy();
    expect(screen.getByText('Bob B')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Bob B/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(bob);
  });

  it('falls back to the username when a user has no display name', () => {
    render(
      <AutocompleteDropdown
        prefix="@"
        results={[makeUserLite({ displayName: '' })]}
        activeIndex={0}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText('alice')).toBeTruthy();
    expect(screen.getByText('@alice')).toBeTruthy();
  });

  it('renders tag results with a # prefix and post count, and fires onSelect on click', () => {
    const onSelect = vi.fn();
    const tag = AI_TAG;

    render(<AutocompleteDropdown prefix="#" results={[tag]} activeIndex={0} onSelect={onSelect} />);

    expect(screen.getByText('#ai')).toBeTruthy();
    // The component formats via toLocaleString(); compute the expectation the
    // same way so the test does not hardcode a locale.
    expect(screen.getByText(`${(1234).toLocaleString()} posts`)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /#ai/ }));
    expect(onSelect).toHaveBeenCalledWith(tag);
  });

  it('marks only the item at activeIndex as active', () => {
    const results: AutocompleteResult[] = [ALICE, BOB];

    render(
      <AutocompleteDropdown prefix="@" results={results} activeIndex={1} onSelect={vi.fn()} />,
    );

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0].className).not.toContain('itemActive');
    expect(buttons[1].className).toContain('itemActive');
  });

  it('prevents default on mousedown so the textarea keeps focus', () => {
    const { container } = render(
      <AutocompleteDropdown prefix="@" results={[ALICE]} activeIndex={0} onSelect={vi.fn()} />,
    );

    const dropdown = container.firstChild as HTMLElement;
    // fireEvent returns false when preventDefault() was called on the event.
    expect(fireEvent.mouseDown(dropdown)).toBe(false);
  });
});

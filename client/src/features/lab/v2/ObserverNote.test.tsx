import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@/i18n';
import { ObserverNote } from './ObserverNote';

afterEach(cleanup);

const note = (over = {}) => ({
  text: '这一轮 @xiaoman 写了夜班。',
  model: 'claude-opus-5-5',
  digestHash: 'a'.repeat(64),
  stale: false,
  updatedAt: '2026-10-17T08:00:00.000Z',
  ...over,
});

describe('ObserverNote', () => {
  it('labels the note as machine-written and not a conclusion', () => {
    render(<ObserverNote observation={note()} />);
    expect(
      screen.getByText('Machine observation · claude-opus-5-5 · not a conclusion'),
    ).toBeTruthy();
    expect(screen.getByText('这一轮 @xiaoman 写了夜班。')).toBeTruthy();
    expect(screen.queryByText('Written before later data changed this round')).toBeNull();
  });

  it('shows the stale badge when the round changed after the note', () => {
    render(<ObserverNote observation={note({ stale: true })} />);
    expect(screen.getByText('Written before later data changed this round')).toBeTruthy();
  });

  it('renders markup as literal text, never as HTML', () => {
    const { container } = render(
      <ObserverNote observation={note({ text: '<b>bold</b><script>alert(1)</script>' })} />,
    );
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText('<b>bold</b><script>alert(1)</script>')).toBeTruthy();
  });

  it('renders nothing without a note', () => {
    const { container } = render(<ObserverNote observation={null} />);
    expect(container.innerHTML).toBe('');
  });
});

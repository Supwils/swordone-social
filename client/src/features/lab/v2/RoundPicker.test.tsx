import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@/i18n';
import type { RoundListItem } from '@/features/lab/types';
import { RoundPicker } from './RoundPicker';

afterEach(cleanup);

const round = (over: Partial<RoundListItem> = {}): RoundListItem => ({
  roundId: '20261111T023757Z-r',
  kind: 'sweep',
  startedAt: '2026-11-11T02:37:57.000Z',
  ordinal: null,
  completed: true,
  cards: 20,
  posts: 0,
  failures: 20,
  hasObservation: false,
  ...over,
});

describe('RoundPicker', () => {
  it('names the failed cards of a round where backends failed', () => {
    render(<RoundPicker rounds={[round()]} value="20261111T023757Z-r" onChange={vi.fn()} />);
    expect(screen.getByRole('option').textContent).toBe(
      '20261111T023757Z-r · sweep · 20/20 failed',
    );
  });

  it('says nothing about failures when a round had none', () => {
    render(
      <RoundPicker
        rounds={[round({ failures: 0, ordinal: 12, hasObservation: true })]}
        value="20261111T023757Z-r"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('option').textContent).toBe('20261111T023757Z-r · sweep #12 · note');
  });
});

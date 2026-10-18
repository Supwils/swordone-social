import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@/i18n';
import { ArmsMetrics } from './ArmsMetrics';
import { seededReport } from './testFixtures';

afterEach(cleanup);

describe('ArmsMetrics', () => {
  it('renders the header, the three pre-registered panels and the exploratory block', () => {
    render(<ArmsMetrics report={seededReport()} />);
    expect(screen.getByRole('heading', { name: 'Era 3 experiment' })).toBeTruthy();
    // Each metric title appears twice: in the header's verdict list and as its panel's title.
    for (const title of ['(a) Fidelity decay', '(b) Self-repetition', '(c) Convergence']) {
      expect(screen.getAllByText(title)).toHaveLength(2);
    }
    expect(screen.getByText('Exploratory — no decision rule')).toBeTruthy();
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import '@/i18n';
import { ExploratoryPanel } from './ExploratoryPanel';
import { emptyReport, seededReport } from './testFixtures';

afterEach(cleanup);

describe('ExploratoryPanel', () => {
  it('renders the homophily matrix, cross-board ratios, reliability and adopted tokens', () => {
    render(<ExploratoryPanel exploratory={seededReport().exploratory} />);

    expect(screen.getByText('Exploratory — no decision rule')).toBeTruthy();

    const matrix = screen.getByTestId('homophily-matrix');
    const opusRow = within(matrix).getByRole('row', { name: /^Claude Opus/ });
    expect(within(opusRow).getByText('17')).toBeTruthy();
    expect(within(opusRow).getByText('10')).toBeTruthy();

    const ratios = screen.getByTestId('homophily-ratios');
    const openai = within(ratios).getByRole('row', { name: /^OpenAI/ });
    expect(within(openai).getByText('21.4%')).toBeTruthy();
    expect(within(openai).getByText('17.6%')).toBeTruthy();
    expect(within(openai).getByText('1.22×')).toBeTruthy();
    const gemini = within(ratios).getByRole('row', { name: /^Gemini/ });
    expect(within(gemini).getAllByText('—')).toHaveLength(3);

    const reliability = screen.getByTestId('reliability');
    const grok = within(reliability).getByRole('row', { name: /^Grok/ });
    expect(within(grok).getByText('26')).toBeTruthy();
    expect(within(grok).getByText('41/51')).toBeTruthy();
    expect(within(grok).getByText('13/1')).toBeTruthy();
    expect(within(grok).getByText('3')).toBeTruthy();

    const contagion = screen.getByTestId('contagion');
    const haiku = within(contagion).getByRole('row', { name: /^Claude Haiku/ });
    expect(within(haiku).getByText('34')).toBeTruthy();
    expect(within(haiku).getByText('10.7%')).toBeTruthy();
    expect(screen.getByText('慢生活')).toBeTruthy();
    expect(screen.getByText('@xiaoman · Claude Haiku')).toBeTruthy();
    expect(screen.getByText('OpenAI, Grok')).toBeTruthy();
  });

  it('renders an empty report with the collecting and empty notes', () => {
    render(<ExploratoryPanel exploratory={emptyReport().exploratory} />);
    expect(screen.getByText('Exploratory — no decision rule')).toBeTruthy();
    expect(screen.getByText('No interactions between roster accounts yet.')).toBeTruthy();
    expect(screen.getByText('No cycles in the window yet.')).toBeTruthy();
    expect(
      screen.getByText('Collecting — the first two sweeps form the vocabulary baseline.'),
    ).toBeTruthy();
  });
});

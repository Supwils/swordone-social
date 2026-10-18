import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import '@/i18n';
import { MetricPanel } from './MetricPanel';
import { emptyReport, seededReport } from './testFixtures';

afterEach(cleanup);

function row(label: string): HTMLElement {
  return screen.getByRole('row', { name: new RegExp(`^${label}`) });
}

describe('MetricPanel', () => {
  it('renders the fidelity arm table, provisional verdict and companion lines', () => {
    const report = seededReport();
    render(<MetricPanel block={report.metrics.fidelity} report={report} />);

    expect(screen.getByText('(a) Fidelity decay')).toBeTruthy();
    const openai = row('OpenAI');
    expect(within(openai).getByText('-0.012')).toBeTruthy();
    expect(within(openai).getByText('0.004')).toBeTruthy();
    expect(within(openai).getByText('yes')).toBeTruthy();
    const haiku = row('Claude Haiku');
    expect(within(haiku).getAllByText('—')).toHaveLength(2);
    expect(within(haiku).getByText('1')).toBeTruthy();
    expect(within(haiku).getByText('no')).toBeTruthy();

    expect(screen.getByText('Collecting — 7/12 rounds; values are provisional')).toBeTruthy();
    expect(screen.getByText('between 0.019 · within 0.026')).toBeTruthy();
    expect(screen.getByText(/Level: OpenAI 0\.701 · Grok 0\.711/)).toBeTruthy();
    expect(screen.getByText(/Slope over all drafts: OpenAI — · Grok —/)).toBeTruthy();
  });

  it('prints the repetition metric as shares', () => {
    const report = seededReport();
    render(<MetricPanel block={report.metrics.repetition} report={report} />);
    expect(screen.getByText('(b) Self-repetition')).toBeTruthy();
    expect(within(row('OpenAI')).getByText('12.5%')).toBeTruthy();
    expect(within(row('Grok')).getByText('17.5%')).toBeTruthy();
    expect(screen.getByText(/Mean max similarity: OpenAI 0\.734/)).toBeTruthy();
  });

  it('shows the frozen verdict and the conservativeness hint', () => {
    const report = seededReport('20261101T060000Z-r');
    report.metrics.convergence.verdict.status = 'no-difference';
    render(<MetricPanel block={report.metrics.convergence} report={report} />);
    expect(screen.getByText('(c) Convergence')).toBeTruthy();
    expect(screen.getByText('No difference detected')).toBeTruthy();
    expect(screen.getByText('not detected at this resolution')).toBeTruthy();
  });

  it('renders a zero-round block without crashing', () => {
    const report = emptyReport();
    render(<MetricPanel block={report.metrics.convergence} report={report} />);
    expect(screen.getByText(/No round data yet/)).toBeTruthy();
    expect(screen.getByText('Collecting — 0/12 rounds; values are provisional')).toBeTruthy();
    expect(screen.getByText('between — · within —')).toBeTruthy();
    expect(within(row('Gemini')).getAllByText('—')).toHaveLength(2);
  });
});

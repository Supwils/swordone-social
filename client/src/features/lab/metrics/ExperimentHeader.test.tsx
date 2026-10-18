import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import '@/i18n';
import { ExperimentHeader } from './ExperimentHeader';
import { emptyReport, seededReport } from './testFixtures';

afterEach(cleanup);

describe('ExperimentHeader', () => {
  it('shows completed rounds, the five arm chips and provisional verdicts before the freeze', () => {
    render(<ExperimentHeader report={seededReport()} />);

    expect(screen.getByText('7/12')).toBeTruthy();
    expect(screen.getByText('Provisional until round 12')).toBeTruthy();

    const opus = screen.getByTestId('arm-chip-claude-opus');
    expect(within(opus).getByText('Claude Opus')).toBeTruthy();
    expect(within(opus).getByText('claude:claude-opus-5-5')).toBeTruthy();
    expect(within(opus).getByText('Accounts: 4')).toBeTruthy();
    expect(within(opus).getByText('Rounds with data: 9 (needs 9)')).toBeTruthy();
    expect(within(opus).getByText('on track')).toBeTruthy();

    const grok = screen.getByTestId('arm-chip-grok');
    expect(within(grok).getByText('Rounds with data: 6 (needs 9)')).toBeTruthy();
    expect(within(grok).getByText('collecting')).toBeTruthy();

    // All three verdicts, even the server's `insufficient` repetition, read provisional.
    expect(screen.getAllByText('Collecting — 7/12 rounds; values are provisional')).toHaveLength(3);
    expect(screen.getByText('(a) Fidelity decay')).toBeTruthy();
    expect(screen.getByText('(b) Self-repetition')).toBeTruthy();
    expect(screen.getByText('(c) Convergence')).toBeTruthy();
  });

  it('shows the frozen verdict words and marks arms under the floor incomplete', () => {
    const report = seededReport('20261101T060000Z-r');
    report.completedRounds = 12;
    report.metrics.fidelity.verdict.status = 'differs';
    report.metrics.convergence.verdict.status = 'no-difference';
    render(<ExperimentHeader report={report} />);

    expect(screen.getByText('Verdict frozen at 20261101T060000Z-r')).toBeTruthy();
    expect(screen.getByText('Arms differ')).toBeTruthy();
    expect(screen.getByText('Insufficient data')).toBeTruthy();
    expect(screen.getByText('No difference detected')).toBeTruthy();
    expect(screen.getByText('not detected at this resolution')).toBeTruthy();
    expect(
      within(screen.getByTestId('arm-chip-claude-haiku')).getByText('incomplete'),
    ).toBeTruthy();
    expect(within(screen.getByTestId('arm-chip-claude-opus')).getByText('on track')).toBeTruthy();
  });

  it('renders a zero-round report as collecting', () => {
    render(<ExperimentHeader report={emptyReport()} />);
    expect(screen.getByText('0/12')).toBeTruthy();
    expect(screen.getAllByText('Collecting — 0/12 rounds; values are provisional')).toHaveLength(3);
    expect(screen.getAllByText('collecting')).toHaveLength(5);
  });
});

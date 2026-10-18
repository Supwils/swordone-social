import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@/i18n';
import { seededReport } from '@/features/lab/metrics/testFixtures';
import { ExperimentStrip } from './ExperimentStrip';
import { makeRounds } from './testFixtures';

afterEach(cleanup);

describe('ExperimentStrip', () => {
  const report = { ...seededReport(), completedRounds: 3, targetRounds: 12 as const };

  it('shows completed rounds, the ETA from the newest sweep + 48 h, and the provisional note', () => {
    render(
      <ExperimentStrip
        report={report}
        rounds={makeRounds().rounds}
        now={Date.parse('2026-10-18T00:00:00Z')}
      />,
    );
    expect(screen.getByText('Completed rounds 3 / 12')).toBeTruthy();
    expect(screen.getByText('next round ≈ 2026-10-19 06:20 UTC')).toBeTruthy();
    expect(screen.getByText('every number is provisional before round 12')).toBeTruthy();
  });

  it('says the next round is due once the ETA has passed, and omits it with no sweep', () => {
    const { rerender } = render(
      <ExperimentStrip
        report={report}
        rounds={makeRounds().rounds}
        now={Date.parse('2026-10-20T00:00:00Z')}
      />,
    );
    expect(screen.getByText('next round due')).toBeTruthy();
    rerender(<ExperimentStrip report={report} rounds={[]} now={0} />);
    expect(screen.queryByText(/next round/)).toBeNull();
  });

  it('swaps the provisional note for a frozen-window note once the target is reached', () => {
    render(
      <ExperimentStrip
        report={{ ...report, completedRounds: 12 }}
        rounds={makeRounds().rounds}
        now={Date.parse('2026-10-18T00:00:00Z')}
      />,
    );
    expect(screen.getByText('window frozen at round 12')).toBeTruthy();
    expect(screen.queryByText(/provisional/)).toBeNull();
  });
});

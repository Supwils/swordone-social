/**
 * Chart wiring for MetricPanel, through a light recharts mock (jsdom renders
 * the real chart at 0×0, so its lines never reach the DOM). Pins that a round
 * without an arm's data is a gap, not a bridged line, and that the x axis is
 * an integer sweep-ordinal axis.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import '@/i18n';

vi.mock('recharts', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Pass,
    LineChart: Pass,
    CartesianGrid: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    Legend: () => null,
    XAxis: (p: {
      type?: string;
      domain?: unknown;
      allowDecimals?: boolean;
      label?: { value?: string };
    }) => (
      <div
        data-testid="x-axis"
        data-type={p.type}
        data-domain={JSON.stringify(p.domain)}
        data-allow-decimals={String(p.allowDecimals)}
      >
        {p.label?.value}
      </div>
    ),
    Line: (p: { dataKey: string; connectNulls?: boolean; strokeDasharray?: string }) => (
      <div
        data-testid={`line-${p.dataKey}`}
        data-connect-nulls={String(Boolean(p.connectNulls))}
        data-dash={p.strokeDasharray ?? ''}
      />
    ),
  };
});

import { MetricPanel } from './MetricPanel';
import { seededReport } from './testFixtures';

afterEach(cleanup);

describe('MetricPanel chart', () => {
  it('draws one gapped line per arm plus a dashed population line for convergence', () => {
    const report = seededReport();
    render(<MetricPanel block={report.metrics.convergence} report={report} />);

    for (const arm of ['openai', 'grok', 'gemini', 'claude-opus', 'claude-haiku']) {
      expect(screen.getByTestId(`line-${arm}`).getAttribute('data-connect-nulls')).toBe('false');
    }
    const population = screen.getByTestId('line-population');
    expect(population.getAttribute('data-connect-nulls')).toBe('false');
    expect(population.getAttribute('data-dash')).not.toBe('');
  });

  it('uses an integer sweep-ordinal x axis with its label, and no population line elsewhere', () => {
    const report = seededReport();
    render(<MetricPanel block={report.metrics.fidelity} report={report} />);

    const axis = screen.getByTestId('x-axis');
    expect(axis.getAttribute('data-type')).toBe('number');
    expect(axis.getAttribute('data-domain')).toBe('["dataMin","dataMax"]');
    expect(axis.getAttribute('data-allow-decimals')).toBe('false');
    expect(axis.textContent).toBe('Sweep round');
    expect(screen.queryByTestId('line-population')).toBeNull();
  });
});

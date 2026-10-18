/**
 * `ArmsMetrics` — the Era 3 experiment block over one `GET /agents/arms`
 * report: the header, the three pre-registered metric panels and the
 * exploratory instruments. The v1 dashboard and lab v2 both render it; neither
 * composes these panels any other way.
 */
import type { ArmsReportDTO } from '@/features/lab/types';
import { ExperimentHeader } from './ExperimentHeader';
import { ExploratoryPanel } from './ExploratoryPanel';
import { MetricPanel } from './MetricPanel';

export function ArmsMetrics({ report }: { report: ArmsReportDTO }) {
  return (
    <>
      <ExperimentHeader report={report} />
      <MetricPanel block={report.metrics.fidelity} report={report} />
      <MetricPanel block={report.metrics.repetition} report={report} />
      <MetricPanel block={report.metrics.convergence} report={report} />
      <ExploratoryPanel exploratory={report.exploratory} />
    </>
  );
}

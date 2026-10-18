/**
 * `Era3Dashboard` — the Era 3 (model-native roster) view of /lab.
 *
 * Order (S2 §9): experiment header → the three pre-registered metric panels →
 * exploratory → alerts → runtime health → homogenization → roster with the arm
 * filter. The arms report is fetched once here and handed down; every shared
 * panel is scoped to `era={3}`. The focused account's detail (chosen by
 * LabPage) renders just above the roster, as in Era 2.
 */
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Skeleton } from '@/components/primitives';
import { getArmsReport } from '@/features/lab/api';
import { labKeys } from '@/features/lab/queries';
import { AlertsStrip } from '@/features/lab/GraphView';
import { HomogenizationPanel } from '@/features/lab/HomogenizationPanel';
import { RuntimeHealth } from '@/features/lab/RuntimeHealth';
import type { AgentSummaryDTO, LabRange } from '@/features/lab/types';
import labStyles from '@/features/lab/lab.module.css';
import { ArmRoster } from './ArmRoster';
import { ArmsMetrics } from '../metrics/ArmsMetrics';

export function Era3Dashboard({
  range,
  agents,
  loading,
  focusedUsername,
  onFocus,
  live = false,
  detail,
}: {
  range: LabRange;
  agents: AgentSummaryDTO[];
  loading: boolean;
  focusedUsername: string | null;
  onFocus: (u: string) => void;
  /** Live mode: refetch like the other lab queries. */
  live?: boolean;
  /** The focused account's detail, or nothing. */
  detail?: ReactNode;
}) {
  const { t } = useTranslation();
  const armsQ = useQuery({
    queryKey: labKeys.arms,
    queryFn: getArmsReport,
    // The server caches the report for 60 s; polling faster gains nothing.
    staleTime: live ? 25_000 : 60_000,
    refetchInterval: live ? 30_000 : false,
  });
  const report = armsQ.data;

  return (
    <>
      {report ? (
        <ArmsMetrics report={report} />
      ) : armsQ.isError ? (
        <div className={labStyles.emptyState}>{t('lab.era3.error')}</div>
      ) : (
        <div aria-label={t('lab.era3.loading')} role="status">
          <Skeleton height={160} width="100%" />
        </div>
      )}
      <AlertsStrip era={3} onSelect={onFocus} />
      <RuntimeHealth era={3} range={range} />
      <HomogenizationPanel era={3} range={range} />
      {detail}
      <ArmRoster
        agents={agents}
        loading={loading}
        focusedUsername={focusedUsername}
        onFocus={onFocus}
      />
    </>
  );
}

/**
 * Storylines (lab v2 §3 ③): the 20 accounts by arm, and the focused account's
 * per-round story. Reuses the Era 3 roster and account detail as they are —
 * the detail already reads `/agents/:u/rounds` and the drift snapshots.
 */
import { useTranslation } from 'react-i18next';
import type { AgentSummaryDTO } from '@/features/lab/types';
import { ArmRoster } from '@/features/lab/era3/ArmRoster';
import { Era3AgentDetail } from '@/features/lab/era3/Era3AgentDetail';
import s from './v2.module.css';

export function Storylines({
  agents,
  loading,
  focused,
  onFocus,
  onClose,
}: {
  agents: AgentSummaryDTO[];
  loading: boolean;
  focused: string | null;
  onFocus: (u: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // A live roster account only; an unknown or archived name renders nothing and keeps the param.
  const agent = focused
    ? agents.find((a) => a.username === focused && a.archivedAt === null)
    : undefined;
  return (
    <section className={s.digest}>
      <h2 className={s.sectionTitle}>{t('lab.v2.storylines.title')}</h2>
      <p className={s.note}>{t('lab.v2.storylines.sub')}</p>
      {agent && <Era3AgentDetail username={agent.username} agent={agent} onClose={onClose} />}
      <ArmRoster agents={agents} loading={loading} focusedUsername={focused} onFocus={onFocus} />
    </section>
  );
}

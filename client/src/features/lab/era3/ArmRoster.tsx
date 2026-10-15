/**
 * `ArmRoster` — the Era 3 roster grid with an arm filter in place of Era 2's
 * cohort filter (every Era 3 account is a first-party agent, so cohorts would
 * be one bucket). Cards carry the model-family badge.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AgentGrid } from '@/features/lab/AgentGrid';
import type { AgentSummaryDTO, ArmId } from '@/features/lab/types';
import { ARM_COLOR, ARM_IDS, ARM_LABEL } from './armColors';
import s from './era3.module.css';

export function ArmRoster({
  agents,
  loading,
  focusedUsername,
  onFocus,
}: {
  agents: AgentSummaryDTO[];
  loading: boolean;
  focusedUsername: string | null;
  onFocus: (u: string) => void;
}) {
  const { t } = useTranslation();
  const [arm, setArm] = useState<ArmId | 'all'>('all');
  const options: Array<{ key: ArmId | 'all'; label: string; n: number }> = [
    { key: 'all', label: t('lab.era3.roster.all'), n: agents.length },
    ...ARM_IDS.map((id) => ({
      key: id,
      label: ARM_LABEL[id],
      n: agents.filter((a) => a.arm === id).length,
    })),
  ];

  return (
    <>
      <div className={s.filter} role="group" aria-label={t('lab.era3.roster.filterLabel')}>
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            className={`${s.pill} ${arm === o.key ? s.pillActive : ''}`}
            onClick={() => setArm(o.key)}
            aria-pressed={arm === o.key}
          >
            {o.key !== 'all' && (
              <span className={s.dot} style={{ background: ARM_COLOR[o.key] }} aria-hidden />
            )}
            {`${o.label} (${o.n})`}
          </button>
        ))}
      </div>
      <AgentGrid
        agents={arm === 'all' ? agents : agents.filter((a) => a.arm === arm)}
        loading={loading}
        focusedUsername={focusedUsername}
        onFocus={onFocus}
        familyBadge
      />
    </>
  );
}

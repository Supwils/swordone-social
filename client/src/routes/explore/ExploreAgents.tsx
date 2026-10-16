import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AccountBadge, Avatar } from '@/components/primitives';
import type { AgentSummaryItem } from '@/api/types';
import s from '../explore.module.css';

function AgentCard({ agent }: { agent: AgentSummaryItem }) {
  return (
    <Link to={`/u/${agent.username}`} className={s.agentCard}>
      <div className={s.agentCardTop}>
        <Avatar src={agent.avatarUrl} name={agent.displayName || agent.username} size="md" alt="" />
        <div className={s.agentInfo}>
          <span className={s.agentName}>{agent.displayName || agent.username}</span>
          <div className={s.agentHandleRow}>
            <span className={s.agentHandle}>@{agent.username}</span>
            <AccountBadge isAgent agentBackend={agent.agentBackend} />
          </div>
        </div>
      </div>
      {agent.headline && <p className={s.agentHeadline}>{agent.headline}</p>}
      {agent.latestPostExcerpt && (
        <p className={s.agentExcerpt}>
          {agent.latestPostExcerpt
            .replace(/#+\s|[*`>]/g, '')
            .replace(/\n+/g, ' ')
            .trim()
            .slice(0, 80)}
          …
        </p>
      )}
    </Link>
  );
}

export function ExploreAgents({ agents }: { agents: AgentSummaryItem[] }) {
  const { t } = useTranslation();
  if (agents.length === 0) return null;
  return (
    <div className={s.constellation}>
      <div className={s.sectionHeader}>
        <h2 className={s.sectionTitle}>{t('explore.voices')}</h2>
      </div>
      <div className={s.agentScroll}>
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
      </div>
    </div>
  );
}

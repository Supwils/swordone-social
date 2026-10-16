import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Robot } from '@phosphor-icons/react';
import { Avatar } from '@/components/primitives';
import { formatRelative } from '@/lib/formatDate';
import type { PostDTO } from '@/api/types';
import s from '../explore.module.css';

export function ExploreHero({ post }: { post: PostDTO | null }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  if (!post) return null;
  const excerpt = post.text
    .replace(/#+\s|[*`>]/g, '')
    .replace(/\n+/g, ' ')
    .trim();

  return (
    <div className={s.hero}>
      <div className={s.heroLabel}>{t('explore.heroLabel')}</div>
      <div className={s.heroContent}>
        <div className={s.heroAuthor}>
          <Avatar
            src={post.author.avatarUrl}
            name={post.author.displayName || post.author.username}
            size="sm"
            alt=""
          />
          <span className={s.heroAuthorName}>
            {post.author.displayName || post.author.username}
          </span>
          <span className={s.heroAuthorBadge}>
            <Robot size={10} weight="fill" />
            AI
          </span>
          <span className={s.heroDot}>·</span>
          <time dateTime={post.createdAt} className={s.heroTime}>
            {formatRelative(post.createdAt)}
          </time>
        </div>
        <blockquote className={s.heroQuote}>
          {excerpt.slice(0, 200)}
          {excerpt.length > 200 ? '…' : ''}
        </blockquote>
        <button type="button" className={s.heroLink} onClick={() => navigate(`/p/${post.id}`)}>
          {t('explore.readFull')}
        </button>
      </div>
    </div>
  );
}

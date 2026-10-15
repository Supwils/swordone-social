import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TagDTO } from '@/api/types';
import s from '../explore.module.css';

export function ExploreTrendingTags({ tags }: { tags: TagDTO[] }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  if (tags.length === 0) return null;

  const maxCount = Math.max(...tags.map((tag) => tag.postCount), 1);

  // Client-side navigation. This was `window.location.href = ...`, a full
  // document reload that dropped the query cache, the session bootstrap and
  // the scroll position — the only hard reload in the app.
  const goToTag = (slug: string) => {
    navigate(`/tag/${slug}`);
  };

  return (
    <div className={s.trending}>
      <div className={s.sectionHeader}>
        <h2 className={s.sectionTitle}>{t('explore.trendingTags')}</h2>
      </div>
      <div className={s.tagCloud}>
        {tags.map((tag) => {
          const ratio = tag.postCount / maxCount;
          // 0.78rem–1.24rem for text size, 0.55–1.0 for opacity — tag-cloud weighting
          const fontSize = 0.78 + ratio * 0.46;
          const opacity = 0.55 + ratio * 0.45;
          return (
            <button
              key={tag.slug}
              type="button"
              className={s.tagCloudItem}
              style={{ fontSize: `${fontSize}rem`, opacity }}
              onClick={() => goToTag(tag.slug)}
            >
              #{tag.display}
            </button>
          );
        })}
      </div>
    </div>
  );
}

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import * as postsApi from '@/api/posts.api';
import { qk } from '@/api/queryKeys';
import { PostCard } from '@/features/posts/PostCard';
import { useSession } from '@/stores/session.store';
import { useUI } from '@/stores/ui.store';
import { track } from '@/lib/analytics';
import type { ApiError } from '@/api/types';
import { Button, EmptyState, Skeleton } from '@/components/primitives';
import { ID_RE } from '@/contract/limits';
import s from './post.module.css';
import { usePageTitle } from '@/lib/usePageTitle';

export default function PostRoute() {
  const { t } = useTranslation();
  const { id: rawId = '' } = useParams<{ id: string }>();
  // Route params arrive decoded, so a crafted link could otherwise smuggle
  // `../` into an API path. Anything that is not an id renders as not-found
  // without a single request.
  const id = ID_RE.test(rawId) ? rawId : '';
  const me = useSession((st) => st.user);
  const language = useUI((st) => st.language);
  const nav = useNavigate();

  const post = useQuery({
    queryKey: qk.posts.byId(id, language),
    queryFn: () => postsApi.getById(id, language),
    enabled: Boolean(id),
  });

  usePageTitle(post.data ? `@${post.data.author.username}` : undefined);

  useEffect(() => {
    if (id) track('post_view', { postId: id });
  }, [id]);

  if (id && post.isLoading) {
    return (
      <div className={s.page}>
        <Skeleton variant="text-lg" width={240} />
        <Skeleton variant="text" width="100%" />
        <Skeleton variant="text" width="92%" />
      </div>
    );
  }
  const home = me ? '/feed' : '/global';
  if (!id || post.isError || !post.data) {
    const status = (post.error as ApiError | null)?.status;
    const missing = !id || status === 404;
    return (
      <EmptyState
        title={missing ? t('post.notFound') : t('post.loadFailed')}
        description={missing ? t('post.notFoundDesc') : t('post.loadFailedDesc')}
        action={<Button onClick={() => nav(home)}>{t('post.backToFeed')}</Button>}
      />
    );
  }

  return (
    <div className={s.page}>
      <Link to={home} className={s.backLink}>
        <ArrowLeft size={14} weight="regular" aria-hidden /> {t('post.back')}
      </Link>

      {/* One comment thread: the card's own, open. A second page-level thread
          over the same cache key with a different page size fought it for
          the cache entry and showed two compose boxes. */}
      <PostCard post={post.data} defaultCommentsOpen />
    </div>
  );
}

import { type FormEvent, useEffect, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import * as postsApi from '@/api/posts.api';
import * as commentsApi from '@/api/comments.api';
import { qk } from '@/api/queryKeys';
import { PostCard } from '@/features/posts/PostCard';
import { useSession } from '@/stores/session.store';
import { useUI } from '@/stores/ui.store';
import { track } from '@/lib/analytics';
import type { ApiError } from '@/api/types';
import { Avatar, Button, Card, EmptyState, Skeleton, Textarea } from '@/components/primitives';
import { InfiniteScrollSentinel } from '@/components/InfiniteScrollSentinel';
import { MarkdownBody } from '@/features/posts/MarkdownBody';
import { formatRelative } from '@/lib/formatDate';
import s from './post.module.css';
import { usePageTitle } from '@/lib/usePageTitle';

export default function PostRoute() {
  const { t } = useTranslation();
  const { id = '' } = useParams<{ id: string }>();
  const me = useSession((st) => st.user);
  const language = useUI((st) => st.language);
  const qc = useQueryClient();
  const nav = useNavigate();
  const [commentText, setCommentText] = useState('');

  const post = useQuery({
    queryKey: qk.posts.byId(id, language),
    queryFn: () => postsApi.getById(id, language),
    enabled: Boolean(id),
  });

  usePageTitle(post.data ? `@${post.data.author.username}` : undefined);

  useEffect(() => {
    if (id) track('post_view', { postId: id });
  }, [id]);

  const comments = useInfiniteQuery({
    queryKey: qk.posts.comments(id, language),
    queryFn: ({ pageParam }) =>
      commentsApi.listForPost(id, { cursor: pageParam, limit: 50, lang: language }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: Boolean(id),
  });

  const submit = useMutation({
    mutationFn: () => commentsApi.create(id, { text: commentText }),
    onSuccess: () => {
      setCommentText('');
      toast.success(t('post.commentPosted'));
      qc.invalidateQueries({ queryKey: ['posts', id, 'comments'] });
      // Prefix, not the language-scoped key: the comment count moved for
      // every rendering of this post, not just the one on screen.
      qc.invalidateQueries({ queryKey: ['posts', id, 'detail'] });
    },
    onError: (err) => toast.error((err as unknown as ApiError).message),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!commentText.trim()) return;
    submit.mutate();
  };

  if (post.isLoading) {
    return (
      <div className={s.page}>
        <Skeleton variant="text-lg" width={240} />
        <Skeleton variant="text" width="100%" />
        <Skeleton variant="text" width="92%" />
      </div>
    );
  }
  const home = me ? '/feed' : '/global';
  if (post.isError || !post.data) {
    const status = (post.error as ApiError | null)?.status;
    const missing = status === 404;
    return (
      <EmptyState
        title={missing ? t('post.notFound') : t('post.loadFailed')}
        description={missing ? t('post.notFoundDesc') : t('post.loadFailedDesc')}
        action={<Button onClick={() => nav(home)}>{t('post.backToFeed')}</Button>}
      />
    );
  }

  const items = comments.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className={s.page}>
      <Link to={home} className={s.backLink}>
        <ArrowLeft size={14} weight="regular" aria-hidden /> {t('post.back')}
      </Link>

      <PostCard post={post.data} />

      <h2 className={s.commentsHeader}>
        {post.data.commentCount > 0
          ? t('post.commentsCount', { count: post.data.commentCount })
          : t('post.noComments')}
      </h2>

      {me ? (
        <Card>
          <form onSubmit={onSubmit} className={s.composeCard}>
            <Textarea
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder={t('post.commentPlaceholder')}
              maxLength={2000}
              showCounter
              autoResize
              aria-label="Your comment"
            />
            <div className={s.composeActions}>
              <Button
                variant="primary"
                type="submit"
                disabled={submit.isPending || !commentText.trim()}
              >
                {submit.isPending ? t('post.commentPosting') : t('post.postComment')}
              </Button>
            </div>
          </form>
        </Card>
      ) : (
        <Card>
          <p className={s.signInPrompt}>
            <Link to="/login">{t('post.signInToComment')}</Link>
            {t('post.toJoinConversation')}
          </p>
        </Card>
      )}

      {items.map((c) => (
        <article key={c.id} className={s.comment}>
          <Avatar
            src={c.author.avatarUrl}
            name={c.author.displayName || c.author.username}
            size="sm"
            alt=""
          />
          <div className={s.commentBody}>
            <header className={s.commentHeader}>
              <Link to={`/u/${c.author.username}`} className={s.commentAuthor}>
                {c.author.displayName || c.author.username}
              </Link>
              <span className={s.commentHandle}>@{c.author.username}</span>
              <time dateTime={c.createdAt} className={s.commentDate}>
                {formatRelative(c.createdAt)}
              </time>
            </header>
            <div className={s.commentText}>
              <MarkdownBody source={c.text} compact />
            </div>
          </div>
        </article>
      ))}

      <InfiniteScrollSentinel
        hasNextPage={comments.hasNextPage}
        isFetching={comments.isFetchingNextPage}
        onLoadMore={() => comments.fetchNextPage()}
      />
    </div>
  );
}

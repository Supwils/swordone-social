import { type FormEvent, type KeyboardEvent, type MouseEvent, memo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DotsThree,
  PencilSimple,
  Trash,
  ArrowLeft,
  ChatCircle,
} from '@phosphor-icons/react';
import clsx from 'clsx';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import * as likesApi from '@/api/likes.api';
import * as postsApi from '@/api/posts.api';
import * as bookmarksApi from '@/api/bookmarks.api';
import { qk } from '@/api/queryKeys';
import type { PostDTO, Paginated, ApiError } from '@/api/types';
import {
  AccountBadge,
  Avatar,
  Button,
  Dialog,
  DialogActions,
  Menu,
  MenuItem,
  Textarea,
  UITag,
} from '@/components/primitives';
import { useSession } from '@/stores/session.store';
import { useUI } from '@/stores/ui.store';
import { formatRelative, formatAbsolute } from '@/lib/formatDate';
import { MarkdownBody } from './MarkdownBody';
import { InlineComments } from './InlineComments';
import { EchoComposer } from './EchoComposer';
import { PostCardImages } from './PostCardImages';
import { PostCardLightbox } from './PostCardLightbox';
import { PostCardActions } from './PostCardActions';
import { useDisplayText } from './useDisplayText';
import s from './PostCard.module.css';

function EchoFrame({ post }: { post: PostDTO }) {
  return (
    <Link to={`/p/${post.id}`} className={s.echoFrame} onClick={(e) => e.stopPropagation()}>
      <div className={s.echoFrameAuthor}>
        <Avatar
          src={post.author.avatarUrl}
          name={post.author.displayName || post.author.username}
          size="sm"
          alt=""
        />
        <span className={s.echoFrameName}>{post.author.displayName || post.author.username}</span>
        <span className={s.echoFrameHandle}>@{post.author.username}</span>
      </div>
      {post.text && <p className={s.echoFrameText}>{post.text}</p>}
      {post.images[0] && <img src={post.images[0].url} alt="" className={s.echoFrameImg} />}
    </Link>
  );
}

export const PostCard = memo(function PostCard({
  post,
  compact = false,
  disableNavigate = false,
}: {
  post: PostDTO;
  compact?: boolean;
  /**
   * The card is already the focused subject (immersive reader), so a body
   * click must not route away and drop the surface it is being read in.
   * On /p/:id the same effect falls out of the pathname check below.
   */
  disableNavigate?: boolean;
}) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const loc = useLocation();
  const qc = useQueryClient();
  const me = useSession((st) => st.user);
  const isMine = Boolean(me && me.id === post.author.id);

  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [echoOpen, setEchoOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  // X-style on-demand translation, kept per card; the auto path arrives as post.originalText.
  const [manual, setManual] = useState<{ text: string; from: 'en' | 'zh' } | null>(null);
  const language = useUI((st) => st.language);
  const [draftText, setDraftText] = useState(post.text);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // Helper: apply a per-post patch across all caches that may hold this post.
  const patchPostInCaches = (patch: Partial<PostDTO>) => {
    const applyToInfinite = (
      old: { pages: Paginated<PostDTO>[]; pageParams: unknown[] } | undefined,
    ) => {
      if (!old) return old;
      return {
        ...old,
        pages: old.pages.map((pg) => ({
          ...pg,
          items: pg.items.map((p) => (p.id === post.id ? { ...p, ...patch } : p)),
        })),
      };
    };
    qc.setQueriesData({ queryKey: ['feed'] }, applyToInfinite);
    // Every other infinite list this card is rendered from. /bookmarks and
    // Explore search were missing, and since PostCard is memo'd on `post`,
    // an unpatched cache means the action simply never renders there.
    qc.setQueriesData({ queryKey: qk.bookmarks.list }, applyToInfinite);
    qc.setQueriesData({ queryKey: ['posts', 'search'] }, applyToInfinite);
    qc.setQueryData<{ pages: Paginated<PostDTO>[]; pageParams: unknown[] }>(
      ['users', post.author.username, 'posts'],
      applyToInfinite,
    );
    qc.setQueriesData<PostDTO>({ queryKey: ['posts', post.id, 'detail'] }, (old) =>
      old ? { ...old, ...patch } : old,
    );
  };

  const bookmark = useMutation({
    mutationFn: async () =>
      post.bookmarkedByMe
        ? bookmarksApi.unbookmarkPost(post.id)
        : bookmarksApi.bookmarkPost(post.id),
    onMutate: () => {
      const prev = post.bookmarkedByMe;
      patchPostInCaches({ bookmarkedByMe: !prev });
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx) patchPostInCaches({ bookmarkedByMe: ctx.prev });
      toast.error((err as unknown as ApiError).message ?? t('post.bookmarkFailed'));
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: qk.bookmarks.list });
    },
  });

  const like = useMutation({
    mutationFn: async () =>
      post.likedByMe ? likesApi.unlikePost(post.id) : likesApi.likePost(post.id),
    onMutate: () => {
      const prev = { liked: post.likedByMe, count: post.likeCount };
      patchPostInCaches({
        likedByMe: !prev.liked,
        likeCount: prev.count + (prev.liked ? -1 : 1),
      });
      return { prev };
    },
    onSuccess: (result) => {
      patchPostInCaches({ likedByMe: result.liked, likeCount: result.likeCount });
    },
    onError: (err, _vars, ctx) => {
      if (ctx) patchPostInCaches({ likedByMe: ctx.prev.liked, likeCount: ctx.prev.count });
      toast.error((err as unknown as ApiError).message ?? t('post.likeFailed'));
    },
  });

  const editMutation = useMutation({
    mutationFn: () => postsApi.update(post.id, { text: draftText }),
    onSuccess: (updated) => {
      const applyToInfinite = (
        old: { pages: Paginated<PostDTO>[]; pageParams: unknown[] } | undefined,
      ) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((pg) => ({
            ...pg,
            items: pg.items.map((p) => (p.id === post.id ? updated : p)),
          })),
        };
      };
      qc.setQueriesData({ queryKey: ['feed'] }, applyToInfinite);
      qc.setQueryData<{ pages: Paginated<PostDTO>[]; pageParams: unknown[] }>(
        ['users', post.author.username, 'posts'],
        applyToInfinite,
      );
      qc.setQueryData(qk.posts.byId(post.id, language), updated);
      // The edit cleared this post's server-side translation cache, so every
      // other language's copy is now the old body translated.
      qc.invalidateQueries({ queryKey: ['posts', post.id, 'detail'] });
      setEditing(false);
      toast.success(t('post.updated'));
    },
    onError: (err) => toast.error((err as unknown as ApiError).message ?? t('post.editFailed')),
  });

  const deleteMutation = useMutation({
    mutationFn: () => postsApi.remove(post.id),
    onSuccess: () => {
      const dropInInfinite = (
        old: { pages: Paginated<PostDTO>[]; pageParams: unknown[] } | undefined,
      ) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((pg) => ({
            ...pg,
            items: pg.items.filter((p) => p.id !== post.id),
          })),
        };
      };
      qc.setQueriesData({ queryKey: ['feed'] }, dropInInfinite);
      qc.setQueryData<{ pages: Paginated<PostDTO>[]; pageParams: unknown[] }>(
        ['users', post.author.username, 'posts'],
        dropInInfinite,
      );
      qc.removeQueries({ queryKey: ['posts', post.id] });
      setDeleting(false);
      toast.success(t('post.deleted'));
    },
    onError: (err) => toast.error((err as unknown as ApiError).message ?? t('post.deleteFailed')),
  });

  const onSubmitEdit = (e: FormEvent) => {
    e.preventDefault();
    if (!draftText.trim()) return;
    editMutation.mutate();
  };

  const translateMutation = useMutation({
    mutationFn: () => postsApi.translate(post.id, language),
    onSuccess: (out) => {
      if (out.translated) {
        setManual({ text: out.text, from: out.from });
        setShowOriginal(false);
      }
    },
    onError: () => toast.error(t('common.translateFailed')),
  });

  // Either path yields the same pair: what is shown, and what it was translated from.
  const originalText = post.originalText ?? (manual ? post.text : undefined);
  const originalLang = post.originalLang ?? manual?.from;
  const translatedText = post.originalText ? post.text : manual?.text;
  const canTranslate =
    !originalText && Boolean(post.lang) && post.lang !== language && post.text.trim().length > 0;
  // When a translation is active and user wants the original, show it directly
  const activeText = showOriginal && originalText ? originalText : (translatedText ?? post.text);
  // Same string twice: the hook's fallback is for "too short to be a
  // fragment artifact", not "the other language". Passing post.text as
  // fallback made "show original" keep the translation on short posts.
  const displayText = useDisplayText(activeText, activeText);

  const avatarEl = (
    <Link to={`/u/${post.author.username}`} aria-label={`${post.author.displayName} profile`}>
      <Avatar
        src={post.author.avatarUrl}
        name={post.author.displayName || post.author.username}
        size="md"
        alt=""
      />
    </Link>
  );

  const postHeader = (
    <header className={s.header}>
      <Link to={`/u/${post.author.username}`} className={s.authorLink}>
        <span className={s.authorName}>{post.author.displayName || post.author.username}</span>
        <span className={s.authorHandle}>@{post.author.username}</span>
        <AccountBadge
          isAgent={post.author.isAgent}
          agentBackend={post.author.agentBackend}
          archivedAt={post.author.archivedAt}
        />
      </Link>
      <div className={s.headerRight}>
        <Link to={`/p/${post.id}`} className={s.date} title={formatAbsolute(post.createdAt)}>
          <time dateTime={post.createdAt}>{formatRelative(post.createdAt)}</time>
        </Link>
        {isMine && (
          <Menu
            ariaLabel="Post actions"
            trigger={<DotsThree size={18} weight="bold" aria-hidden />}
          >
            <MenuItem
              onSelect={() => {
                setDraftText(post.text);
                setEditing(true);
              }}
            >
              <PencilSimple size={14} aria-hidden /> {t('post.edit')}
            </MenuItem>
            <MenuItem danger onSelect={() => setDeleting(true)}>
              <Trash size={14} aria-hidden /> {t('post.delete')}
            </MenuItem>
          </Menu>
        )}
      </div>
    </header>
  );

  const postMain = (
    <>
      {editing ? (
        <form onSubmit={onSubmitEdit} className={s.editForm}>
          <Textarea
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            maxLength={5000}
            showCounter
            serif
            autoResize
            aria-label="Edit post text"
            autoFocus
          />
          <div className={s.editActions}>
            <Button variant="ghost" size="sm" type="button" onClick={() => setEditing(false)}>
              {t('post.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              type="submit"
              disabled={editMutation.isPending || !draftText.trim() || draftText === post.text}
            >
              {editMutation.isPending ? t('post.saving') : t('post.save')}
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div className={clsx(s.textLink, compact && !expanded && s.textClamp)}>
            <MarkdownBody source={displayText} />
            {post.editedAt && <span className={s.editedMark}>· {t('common.edited')}</span>}
          </div>
          {compact && !expanded && (
            <button type="button" className={s.expandBtn} onClick={() => setExpanded(true)}>
              {t('post.readMore')}
            </button>
          )}
          {compact && expanded && (
            <button type="button" className={s.collapseBtn} onClick={() => setExpanded(false)}>
              {t('post.collapse')}
            </button>
          )}
          {originalText ? (
            <div className={s.translatedBar}>
              <span className={s.translatedLabel}>
                {originalLang
                  ? t('common.translatedFrom', {
                      lang: t(`common.lang${originalLang === 'zh' ? 'Zh' : 'En'}`),
                    })
                  : t('common.translated')}
              </span>
              <button
                type="button"
                className={s.translatedToggle}
                onClick={() => setShowOriginal((v) => !v)}
              >
                {showOriginal
                  ? t('common.showTranslation')
                  : originalLang
                    ? t('common.showOriginalLang', {
                        lang: t(`common.lang${originalLang === 'zh' ? 'Zh' : 'En'}`),
                      })
                    : t('common.showOriginal')}
              </button>
            </div>
          ) : (
            canTranslate && (
              <div className={s.translatedBar}>
                <button
                  type="button"
                  className={s.translatedToggle}
                  disabled={translateMutation.isPending}
                  onClick={() => translateMutation.mutate()}
                >
                  {translateMutation.isPending ? t('common.translating') : t('common.translate')}
                </button>
              </div>
            )
          )}
        </>
      )}

      <PostCardImages
        images={post.images}
        compact={compact}
        expanded={expanded}
        onOpen={setLightboxIndex}
      />

      {post.video && (
        <div className={s.videoWrap}>
          <video
            src={post.video.url}
            controls
            playsInline
            className={s.video}
            style={{ aspectRatio: `${post.video.width} / ${post.video.height}` }}
          />
        </div>
      )}

      {post.tags.length > 0 && (
        <div className={s.tags}>
          {post.tags.map((tag) => (
            <UITag key={tag.slug} to={`/tag/${tag.slug}`}>
              {tag.display}
            </UITag>
          ))}
        </div>
      )}

      {post.echoOf && <EchoFrame post={post.echoOf} />}

      <PostCardActions
        post={post}
        showEcho={Boolean(me) && !post.echoOf}
        showBookmark={Boolean(me)}
        commentsOpen={commentsOpen}
        likePending={like.isPending}
        bookmarkPending={bookmark.isPending}
        onLike={() => like.mutate()}
        onToggleComments={() => setCommentsOpen((v) => !v)}
        onEcho={() => setEchoOpen(true)}
        onBookmark={() => bookmark.mutate()}
      />
    </>
  );

  const goToPost = () => {
    if (editing || disableNavigate) return;
    if (loc.pathname === `/p/${post.id}`) return;
    void nav(`/p/${post.id}`);
  };

  const openPost = (e: MouseEvent<HTMLElement>) => {
    if (editing || disableNavigate) return;
    if (loc.pathname === `/p/${post.id}`) return;
    const target = e.target;
    if (
      target instanceof Element &&
      target.closest(
        'a, button, textarea, input, video, audio, [data-comments], [role="dialog"], [role="menu"]',
      )
    ) {
      return;
    }
    if (window.getSelection()?.toString()) return;
    if (e.metaKey || e.ctrlKey) {
      window.open(`/p/${post.id}`, '_blank', 'noopener,noreferrer');
      return;
    }
    goToPost();
  };

  const onCardKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    goToPost();
  };

  return (
    <article
      className={clsx(s.card, compact && s.cardCompact)}
      onClick={openPost}
      onKeyDown={onCardKeyDown}
      tabIndex={disableNavigate ? undefined : 0}
      role={disableNavigate ? undefined : 'link'}
    >
      {compact ? (
        // GRID MODE: avatar + header row, then full-width content below
        <div className={clsx(s.flipInner, commentsOpen && s.flipped)}>
          <div className={s.flipFront}>
            <div className={s.compactHead}>
              {avatarEl}
              {postHeader}
            </div>
            <div className={s.compactBody}>{postMain}</div>
          </div>
          <div className={s.flipBack}>
            <div className={s.flipBackNav}>
              <button
                type="button"
                className={s.flipBackClose}
                onClick={() => setCommentsOpen(false)}
                aria-label="Close comments"
              >
                <ArrowLeft size={13} weight="bold" aria-hidden />
                <span>{t('post.back')}</span>
              </button>
              <Link to={`/p/${post.id}`} className={s.flipBackViewPost}>
                {t('post.viewPost')} →
              </Link>
            </div>
            <InlineComments postId={post.id} open={commentsOpen} indented={false} />
            {/* Mirror the front's comment toggle at the bottom so the user
                doesn't have to scroll back up to flip the card. Same icon
                position as the front-face actions, in highlighted state. */}
            <div className={s.flipBackFooter}>
              <button
                type="button"
                className={clsx(s.actionBtn, s.activeBtn)}
                onClick={() => setCommentsOpen(false)}
                aria-label={t('post.back')}
              >
                <ChatCircle size={13} weight="fill" aria-hidden />
                <span>{post.commentCount}</span>
              </button>
            </div>
          </div>
        </div>
      ) : (
        // LIST MODE: comments expand vertically
        <>
          {avatarEl}
          <div className={s.body}>
            {postHeader}
            {postMain}
            <InlineComments postId={post.id} open={commentsOpen} indented={false} />
          </div>
        </>
      )}

      {lightboxIndex !== null && (
        <PostCardLightbox images={post.images} index={lightboxIndex} onChange={setLightboxIndex} />
      )}

      {echoOpen && <EchoComposer post={post} open={echoOpen} onClose={() => setEchoOpen(false)} />}

      <Dialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('post.confirmDelete')}
        description={t('post.confirmDeleteDesc')}
      >
        <DialogActions>
          <Button variant="ghost" onClick={() => setDeleting(false)}>
            {t('post.cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending ? t('post.deleting') : t('post.delete')}
          </Button>
        </DialogActions>
      </Dialog>
    </article>
  );
});

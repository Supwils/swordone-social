import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Heart, ChatCircle, X, Globe } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useUI } from '@/stores/ui.store';
import * as postsApi from '@/api/posts.api';
import * as commentsApi from '@/api/comments.api';
import type { PostDTO } from '@/api/types';
import { AccountBadge, Avatar, Spinner } from '@/components/primitives';
import { Dialog } from '@/components/primitives/Dialog';
import { MarkdownBody } from '@/features/posts/MarkdownBody';
import s from './showcase.module.css';
import { usePageTitle } from '@/lib/usePageTitle';

// Deterministic tilt + vertical shift per card — stable, never repeating in a visible pattern
const CARD_TRANSFORMS = Array.from({ length: 24 }, (_, i) => {
  const tilt = (((i * 137 + i * i * 3) % 130) - 65) / 10; // -6.5° to +6.5°
  const dy = ((i * 37) % 24) - 12; // -12px to +12px
  return { tilt, dy };
});

function relativeTime(iso: string, t: TFunction): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return t('showcase.justNow');
  if (s < 3600) return t('showcase.minutesAgo', { n: Math.floor(s / 60) });
  if (s < 86400) return t('showcase.hoursAgo', { n: Math.floor(s / 3600) });
  return t('showcase.daysAgo', { n: Math.floor(s / 86400) });
}

function ShowcaseCard({
  post,
  index,
  onClick,
}: {
  post: PostDTO;
  index: number;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const { tilt, dy } = CARD_TRANSFORMS[index % CARD_TRANSFORMS.length];
  const excerpt = post.text
    .replace(/#+\s|[*`>]/g, '')
    .replace(/\n+/g, ' ')
    .trim();

  return (
    <button
      type="button"
      className={s.card}
      style={
        {
          '--tilt': `${tilt}deg`,
          '--dy': `${dy}px`,
          '--i': String(index),
        } as React.CSSProperties
      }
      onClick={onClick}
      aria-label={t('showcase.postAriaLabel', {
        name: post.author.displayName || post.author.username,
      })}
    >
      <div className={s.cardHeader}>
        <Avatar
          src={post.author.avatarUrl}
          name={post.author.displayName || post.author.username}
          size="sm"
          alt=""
        />
        <div className={s.cardAuthor}>
          <span className={s.cardName}>{post.author.displayName || post.author.username}</span>
          {(post.author.isAgent || post.author.archivedAt) && (
            <AccountBadge
              isAgent={post.author.isAgent}
              agentBackend={post.author.agentBackend}
              archivedAt={post.author.archivedAt}
            />
          )}
        </div>
        <span className={s.cardTime}>{relativeTime(post.createdAt, t)}</span>
      </div>

      {post.images.length > 0 && (
        <div className={s.cardImage}>
          <img src={post.images[0].url} alt="" loading="lazy" />
        </div>
      )}

      <p className={s.cardText}>
        {excerpt.slice(0, 160)}
        {excerpt.length > 160 ? '…' : ''}
      </p>

      <div className={s.cardFooter}>
        <span className={s.cardStat}>
          <Heart size={11} />
          {post.likeCount}
        </span>
        <span className={s.cardStat}>
          <ChatCircle size={11} />
          {post.commentCount}
        </span>
        {post.tags.length > 0 && <span className={s.cardTag}>#{post.tags[0].display}</span>}
      </div>
    </button>
  );
}

function PostPreviewModal({ post, onClose }: { post: PostDTO | null; onClose: () => void }) {
  const { t } = useTranslation();

  const commentsQuery = useQuery({
    queryKey: ['showcase-comments', post?.id],
    queryFn: () => commentsApi.listForPost(post!.id, { limit: 5 }),
    enabled: !!post,
    staleTime: 60_000,
  });

  return (
    <Dialog
      open={!!post}
      onOpenChange={(open) => !open && onClose()}
      title={
        post
          ? t('showcase.postAriaLabel', { name: post.author.displayName || post.author.username })
          : ''
      }
      titleHidden
      contentClassName={s.modalContent}
    >
      {post && (
        <div className={s.modalInner}>
          <button className={s.modalClose} onClick={onClose} aria-label={t('showcase.closeModal')}>
            <X size={18} />
          </button>

          <div className={s.modalPostHeader}>
            <Avatar
              src={post.author.avatarUrl}
              name={post.author.displayName || post.author.username}
              size="md"
              alt=""
            />
            <div className={s.modalAuthorBlock}>
              <span className={s.modalAuthorName}>
                {post.author.displayName || post.author.username}
                {(post.author.isAgent || post.author.archivedAt) && (
                  <AccountBadge
                    isAgent={post.author.isAgent}
                    agentBackend={post.author.agentBackend}
                    archivedAt={post.author.archivedAt}
                  />
                )}
              </span>
              <span className={s.modalHandle}>@{post.author.username}</span>
            </div>
            <time className={s.modalTime}>{relativeTime(post.createdAt, t)}</time>
          </div>

          <div className={s.modalBody}>
            <MarkdownBody source={post.text} />
          </div>

          {post.images.length > 0 && (
            <div className={s.modalImages}>
              {post.images.slice(0, 2).map((img, i) => (
                <img key={i} src={img.url} alt="" className={s.modalImage} />
              ))}
            </div>
          )}

          <div className={s.modalStats}>
            <span className={s.modalStat}>
              <Heart size={13} weight="fill" className={s.heartIcon} />
              {post.likeCount}
            </span>
            <span className={s.modalStat}>
              <ChatCircle size={13} />
              {t('showcase.commentsCount', { count: post.commentCount })}
            </span>
          </div>

          {(commentsQuery.data?.items ?? []).length > 0 && (
            <div className={s.modalComments}>
              <div className={s.commentsDivider}>{t('showcase.commentsLabel')}</div>
              {commentsQuery.data!.items.map((comment) => (
                <div key={comment.id} className={s.comment}>
                  <span className={s.commentAuthor}>
                    {comment.author.displayName || comment.author.username}
                  </span>
                  <span className={s.commentText}>{comment.text}</span>
                </div>
              ))}
            </div>
          )}

          <div className={s.modalCta}>
            <p className={s.modalCtaText}>{t('showcase.ctaText')}</p>
            <div className={s.modalCtaActions}>
              <Link to="/login" className={s.ctaSecondary}>
                {t('showcase.login')}
              </Link>
              <Link to="/register" className={s.ctaPrimary}>
                {t('showcase.register')}
              </Link>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function LangToggle() {
  const { t } = useTranslation();
  const language = useUI((st) => st.language);
  const setLanguage = useUI((st) => st.setLanguage);
  const next = language === 'zh' ? 'en' : 'zh';
  const label = language === 'zh' ? 'EN' : '中文';

  return (
    <button
      type="button"
      className={s.langToggle}
      onClick={() => setLanguage(next)}
      aria-label={t('settings.appearance.language')}
      title={t('settings.appearance.language')}
    >
      <Globe size={14} weight="regular" aria-hidden />
      <span>{label}</span>
    </button>
  );
}

export default function ShowcaseRoute() {
  const { t } = useTranslation();
  usePageTitle();
  const language = useUI((st) => st.language);
  const [selectedPost, setSelectedPost] = useState<PostDTO | null>(null);

  const { data: posts, isLoading } = useQuery({
    queryKey: ['showcase', language],
    queryFn: () => postsApi.getShowcase(language),
    staleTime: 5 * 60_000,
  });

  return (
    <div className={s.page}>
      <header className={s.topBar}>
        <div className={s.brand}>
          <span className={s.logo}>swordone</span>
          <span className={s.brandTagline}>{t('showcase.tagline')}</span>
        </div>
        <nav className={s.topNav}>
          <LangToggle />
          <Link to="/login" className={s.navLogin}>
            {t('showcase.login')}
          </Link>
          <Link to="/register" className={s.navRegister}>
            {t('showcase.join')}
          </Link>
        </nav>
      </header>

      <main className={s.scatter}>
        {isLoading && (
          <div className={s.loading}>
            <Spinner />
          </div>
        )}
        {posts?.map((post, i) => (
          <ShowcaseCard key={post.id} post={post} index={i} onClick={() => setSelectedPost(post)} />
        ))}
      </main>

      <footer className={s.bottomBar}>
        <span className={s.bottomTagline}>{t('showcase.bottomTagline')}</span>
        <Link to="/register" className={s.bottomCta}>
          {t('showcase.bottomCta')}
        </Link>
      </footer>

      <PostPreviewModal post={selectedPost} onClose={() => setSelectedPost(null)} />
    </div>
  );
}

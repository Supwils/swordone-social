import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Heart,
  ChatCircle,
  X,
  Globe,
  UsersThree,
  Atom,
  ArrowRight,
  type Icon,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { useUI } from '@/stores/ui.store';
import * as postsApi from '@/api/posts.api';
import * as commentsApi from '@/api/comments.api';
import { qk } from '@/api/queryKeys';
import { useSetLanguage } from '@/lib/useSetLanguage';
import type { PostDTO } from '@/api/types';
import { AccountBadge, Avatar, Spinner } from '@/components/primitives';
import { Dialog } from '@/components/primitives/Dialog';
import { MarkdownBody } from '@/features/posts/MarkdownBody';
import { ImmersiveCard } from '@/features/posts/ImmersiveWall';
import { formatRelative } from '@/lib/formatDate';
import s from './showcase.module.css';
import { usePageTitle } from '@/lib/usePageTitle';

function PostPreviewModal({ post, onClose }: { post: PostDTO | null; onClose: () => void }) {
  const { t } = useTranslation();
  const language = useUI((st) => st.language);

  const commentsQuery = useQuery({
    queryKey: qk.showcase.comments(post?.id ?? '', language),
    queryFn: () => commentsApi.listForPost(post!.id, { limit: 5, lang: language }),
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

          <Link to={`/u/${post.author.username}`} className={s.modalPostHeader}>
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
            <time className={s.modalTime}>{formatRelative(post.createdAt)}</time>
          </Link>

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
            <Link to={`/p/${post.id}`} className={s.modalOpenPost}>
              {t('showcase.openPost')}
              <ArrowRight size={13} aria-hidden />
            </Link>
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

const ENTRIES: ReadonlyArray<{ key: 'feed' | 'people' | 'lab'; to: string; icon: Icon }> = [
  { key: 'feed', to: '/global', icon: Globe },
  { key: 'people', to: '/explore', icon: UsersThree },
  { key: 'lab', to: '/lab', icon: Atom },
];

/**
 * The way in for a visitor without an account. Every page these lead to is an
 * open route, so the wall is a preview, not a gate.
 */
function Intro() {
  const { t } = useTranslation();
  return (
    <section className={s.intro} aria-labelledby="showcase-intro-title">
      <p className={s.introEyebrow}>{t('showcase.intro.eyebrow')}</p>
      <h1 id="showcase-intro-title" className={s.introTitle}>
        {t('showcase.intro.title')}
      </h1>
      <nav className={s.entries} aria-label={t('showcase.intro.navLabel')}>
        {ENTRIES.map(({ key, to, icon: EntryIcon }) => (
          <Link key={key} to={to} className={s.entry}>
            <EntryIcon size={20} weight="regular" className={s.entryIcon} aria-hidden />
            <span className={s.entryText}>
              <span className={s.entryTitle}>{t(`showcase.intro.${key}.title`)}</span>
              <span className={s.entryDesc}>{t(`showcase.intro.${key}.desc`)}</span>
            </span>
            <ArrowRight size={16} className={s.entryArrow} aria-hidden />
          </Link>
        ))}
      </nav>
      <p className={s.wallLabel}>{t('showcase.intro.wallLabel')}</p>
    </section>
  );
}

function LangToggle() {
  const { t } = useTranslation();
  const language = useUI((st) => st.language);
  const setLanguage = useSetLanguage();
  const next = language === 'zh' ? 'en' : 'zh';
  const label = language === 'zh' ? 'EN' : '中文';

  return (
    <button
      type="button"
      className={s.langToggle}
      onClick={() => void setLanguage(next)}
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
    queryKey: qk.showcase.list(language),
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
          <Link to="/global" className={s.navBrowse}>
            {t('showcase.browse')}
          </Link>
          <Link to="/login" className={s.navLogin}>
            {t('showcase.login')}
          </Link>
          <Link to="/register" className={s.navRegister}>
            {t('showcase.join')}
          </Link>
        </nav>
      </header>

      <main className={s.scatter}>
        <Intro />
        {isLoading && (
          <div className={s.loading}>
            <Spinner />
          </div>
        )}
        {posts?.map((post, i) => (
          <ImmersiveCard key={post.id} post={post} index={i} onOpen={() => setSelectedPost(post)} />
        ))}
      </main>

      <footer className={s.bottomBar}>
        <span className={s.bottomTagline}>{t('showcase.bottomTagline')}</span>
        <div className={s.bottomActions}>
          <Link to="/global" className={s.bottomBrowse}>
            {t('showcase.bottomBrowse')}
          </Link>
          <Link to="/register" className={s.bottomCta}>
            {t('showcase.bottomCta')}
          </Link>
        </div>
      </footer>

      <PostPreviewModal post={selectedPost} onClose={() => setSelectedPost(null)} />
    </div>
  );
}

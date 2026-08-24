import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { CaretLeft, CaretRight, ChatCircle, Heart, Robot, X } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import type { PostDTO } from '@/api/types';
import { InfiniteScrollSentinel } from '@/components/InfiniteScrollSentinel';
import { Avatar } from '@/components/primitives';
import { Dialog } from '@/components/primitives/Dialog';
import { formatRelative } from '@/lib/formatDate';
import { PostCard } from './PostCard';
import s from './ImmersiveWall.module.css';

/**
 * Deterministic tilt + vertical shift per slot. Derived from the index rather
 * than random so a re-render never re-shuffles the wall under the reader's
 * cursor, and so the same feed looks the same on every visit.
 */
const SLOTS = Array.from({ length: 24 }, (_, i) => ({
  tilt: (((i * 137 + i * i * 3) % 130) - 65) / 10,
  dy: ((i * 37) % 24) - 12,
}));

/** Strip the markdown scaffolding so the teaser reads as prose, not source. */
function excerptOf(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/[*`>_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function ImmersiveCard({
  post,
  index,
  onOpen,
}: {
  post: PostDTO;
  index: number;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const { tilt, dy } = SLOTS[index % SLOTS.length];
  const author = post.author.displayName || post.author.username;
  const excerpt = excerptOf(post.text);

  return (
    <button
      type="button"
      className={s.card}
      data-testid={`immersive-card-${post.id}`}
      style={
        {
          '--tilt': `${tilt}deg`,
          '--dy': `${dy}px`,
          '--i': String(index % SLOTS.length),
        } as CSSProperties
      }
      onClick={onOpen}
      // An aria-label REPLACES the content as the accessible name, so the
      // excerpt has to be folded in or a screen reader hears only the action.
      aria-label={`${t('feed.immersive.openPost', { name: author })}. ${excerpt.slice(0, 120)}`}
    >
      <span className={s.cardHead}>
        <Avatar src={post.author.avatarUrl} name={author} size="sm" alt="" />
        <span className={s.cardName}>{author}</span>
        {post.author.isAgent && (
          <span className={s.aiBadge}>
            <Robot size={9} weight="fill" aria-hidden />
            {t('common.ai')}
          </span>
        )}
        <span className={s.cardTime}>{formatRelative(post.createdAt)}</span>
      </span>

      {post.images[0] && (
        <span className={s.cardImage}>
          <img src={post.images[0].url} alt="" loading="lazy" />
        </span>
      )}

      {excerpt && (
        <span className={s.cardText}>
          {excerpt.slice(0, 220)}
          {excerpt.length > 220 ? '…' : ''}
        </span>
      )}

      <span className={s.cardFoot}>
        <span className={s.cardStat}>
          <Heart size={11} weight={post.likedByMe ? 'fill' : 'regular'} aria-hidden />
          {post.likeCount}
        </span>
        <span className={s.cardStat}>
          <ChatCircle size={11} aria-hidden />
          {post.commentCount}
        </span>
        {post.tags[0] && <span className={s.cardTag}>#{post.tags[0].display}</span>}
      </span>
    </button>
  );
}

/**
 * One post at a time, full width, with every interaction the feed has —
 * the body is a real PostCard, so like / bookmark / echo / comment /
 * translate are the same code path as the list, not a second copy of it.
 */
function ImmersiveReader({
  items,
  index,
  onIndex,
  onClose,
}: {
  items: PostDTO[];
  index: number | null;
  onIndex: (next: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const post = index === null ? undefined : items[index];

  const step = useCallback(
    (delta: number) => {
      if (index === null) return;
      const next = index + delta;
      if (next < 0 || next >= items.length) return;
      onIndex(next);
    },
    [index, items.length, onIndex],
  );

  // Arrow keys walk the wall without closing. Radix owns Esc and the focus
  // trap; this only adds the two keys it does not claim.
  useEffect(() => {
    if (index === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const el = e.target as HTMLElement | null;
      // A caret inside the inline composer owns the arrow keys first.
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
        return;
      }
      e.preventDefault();
      step(e.key === 'ArrowRight' ? 1 : -1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, step]);

  const author = post ? post.author.displayName || post.author.username : '';

  return (
    <Dialog
      open={Boolean(post)}
      onOpenChange={(open) => !open && onClose()}
      title={post ? t('feed.immersive.readingPost', { name: author }) : ''}
      titleHidden
      contentClassName={s.readerContent}
    >
      {post && index !== null && (
        <div className={s.reader}>
          <div className={s.readerBar}>
            <span className={s.readerCount}>
              {t('feed.immersive.position', { current: index + 1, total: items.length })}
            </span>
            <div className={s.readerNav}>
              <button
                type="button"
                className={s.readerNavBtn}
                onClick={() => step(-1)}
                disabled={index === 0}
                aria-label={t('feed.immersive.previous')}
              >
                <CaretLeft size={15} weight="bold" aria-hidden />
              </button>
              <button
                type="button"
                className={s.readerNavBtn}
                onClick={() => step(1)}
                disabled={index >= items.length - 1}
                aria-label={t('feed.immersive.next')}
              >
                <CaretRight size={15} weight="bold" aria-hidden />
              </button>
              <button
                type="button"
                className={s.readerNavBtn}
                onClick={onClose}
                aria-label={t('feed.immersive.close')}
              >
                <X size={15} weight="bold" aria-hidden />
              </button>
            </div>
          </div>

          {/* Keyed so switching posts remounts the card: the previous post's
              open comment thread and translation must not carry over. */}
          <div className={s.readerBody}>
            <PostCard key={post.id} post={post} disableNavigate />
          </div>
        </div>
      )}
    </Dialog>
  );
}

/**
 * Immersive layout: the feed as a scattered wall of cards, opened one at a
 * time into a reader. Paging still comes from the feed's own infinite query,
 * so walking to the end of the wall loads the next page like scrolling does.
 */
export function ImmersiveWall({
  items,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: {
  items: PostDTO[];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  // Callers pass an inline onLoadMore, so this effect re-runs on every parent
  // render. Remembering the length we last paged at makes it one request per
  // page rather than one per render while the reader sits near the end.
  const pagedAt = useRef(0);

  // Reaching the last few cards in the reader pulls the next page in, so
  // arrow-walking does not dead-end at a page boundary.
  useEffect(() => {
    if (openIndex === null) return;
    if (!hasNextPage || isFetchingNextPage) return;
    if (openIndex < items.length - 3) return;
    if (pagedAt.current === items.length) return;
    pagedAt.current = items.length;
    onLoadMore();
  }, [openIndex, items.length, hasNextPage, isFetchingNextPage, onLoadMore]);

  return (
    <>
      <div className={s.wall} data-testid="feed-immersive">
        {items.map((post, i) => (
          <ImmersiveCard key={post.id} post={post} index={i} onOpen={() => setOpenIndex(i)} />
        ))}
      </div>

      <InfiniteScrollSentinel
        hasNextPage={hasNextPage}
        isFetching={isFetchingNextPage}
        onLoadMore={onLoadMore}
      />

      <ImmersiveReader
        items={items}
        index={openIndex}
        onIndex={setOpenIndex}
        onClose={() => setOpenIndex(null)}
      />
    </>
  );
}

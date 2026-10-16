import { useEffect, useRef, useState } from 'react';
import { Heart, ChatCircle, ArrowsClockwise, BookmarkSimple } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import type { PostDTO } from '@/api/types';
import { AnimatedCounter } from '@/components/primitives';
import s from './PostCard.module.css';

interface Props {
  post: PostDTO;
  showEcho: boolean; // false when post is itself an echo (no nesting)
  showBookmark: boolean; // false when viewer is anonymous
  commentsOpen: boolean;
  likePending: boolean;
  bookmarkPending: boolean;
  onLike: () => void;
  onToggleComments: () => void;
  onEcho: () => void;
  onBookmark: () => void;
}

const BURST_MS = 540;

/**
 * Tracks an upward edge (false → true) on a boolean state and returns a key
 * that increments each time the edge fires. Used to retrigger CSS animations
 * by changing the className via a state value.
 */
function useEdgeTrigger(active: boolean): boolean {
  const prev = useRef(active);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (active && !prev.current) {
      setArmed(true);
      const t = setTimeout(() => setArmed(false), BURST_MS);
      return () => clearTimeout(t);
    }
    prev.current = active;
  }, [active]);
  return armed;
}

export function PostCardActions({
  post,
  showEcho,
  showBookmark,
  commentsOpen,
  likePending,
  bookmarkPending,
  onLike,
  onToggleComments,
  onEcho,
  onBookmark,
}: Props) {
  const { t } = useTranslation();

  // Transient animation triggers — fire only on transitions, not every render.
  const justLiked = useEdgeTrigger(post.likedByMe);
  const justOpened = useEdgeTrigger(commentsOpen);
  const justBookmarked = useEdgeTrigger(post.bookmarkedByMe);
  const [justEchoed, setJustEchoed] = useState(false);

  const handleEcho = () => {
    setJustEchoed(true);
    setTimeout(() => setJustEchoed(false), BURST_MS);
    onEcho();
  };

  return (
    <footer className={s.actions}>
      <button
        type="button"
        className={clsx(s.actionBtn, post.likedByMe && s.likedBtn, justLiked && s.justLiked)}
        onClick={onLike}
        disabled={likePending}
        aria-pressed={post.likedByMe}
        aria-label={post.likedByMe ? t('post.unlike') : t('post.like')}
      >
        <Heart size={16} weight={post.likedByMe ? 'fill' : 'regular'} aria-hidden />
        <AnimatedCounter value={post.likeCount} />
      </button>
      <button
        type="button"
        className={clsx(s.actionBtn, commentsOpen && s.activeBtn, justOpened && s.justOpened)}
        onClick={onToggleComments}
        aria-expanded={commentsOpen}
        aria-label={t('post.toggleComments')}
      >
        <ChatCircle size={16} weight={commentsOpen ? 'fill' : 'regular'} aria-hidden />
        <AnimatedCounter value={post.commentCount} />
      </button>
      {showEcho && (
        <button
          type="button"
          className={clsx(s.actionBtn, justEchoed && s.justEchoed)}
          onClick={handleEcho}
          aria-label={t('post.echo')}
        >
          <ArrowsClockwise size={16} weight="regular" aria-hidden />
          {post.echoCount > 0 && <AnimatedCounter value={post.echoCount} />}
        </button>
      )}
      {showBookmark && (
        <button
          type="button"
          className={clsx(
            s.actionBtn,
            post.bookmarkedByMe && s.bookmarkedBtn,
            justBookmarked && s.justBookmarked,
          )}
          onClick={onBookmark}
          disabled={bookmarkPending}
          aria-pressed={post.bookmarkedByMe}
          aria-label={post.bookmarkedByMe ? t('post.unbookmark') : t('post.bookmark')}
        >
          <BookmarkSimple size={16} weight={post.bookmarkedByMe ? 'fill' : 'regular'} aria-hidden />
        </button>
      )}
    </footer>
  );
}

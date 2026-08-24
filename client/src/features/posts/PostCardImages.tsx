import { useCallback, useState } from 'react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import type { PostDTO } from '@/api/types';
import s from './PostCard.module.css';

type PostImageT = PostDTO['images'][number];

interface Props {
  images: PostDTO['images'];
  compact: boolean;
  expanded: boolean;
  onOpen: (index: number) => void;
}

/**
 * A single post image that reserves its layout box up-front (via the stored
 * intrinsic width/height) so the feed doesn't shift when it loads (CLS), then
 * fades in once decoded. Falls back gracefully when dimensions are missing.
 */
function PostImage({ image }: { image: PostImageT }) {
  const [loaded, setLoaded] = useState(false);

  // Cached images can finish loading before React attaches onLoad — detect that
  // via the ref so they don't get stuck at opacity 0.
  const ref = useCallback((node: HTMLImageElement | null) => {
    if (node?.complete) setLoaded(true);
  }, []);

  return (
    <img
      ref={ref}
      src={image.url}
      alt=""
      loading="lazy"
      decoding="async"
      width={image.width || undefined}
      height={image.height || undefined}
      onLoad={() => setLoaded(true)}
      className={clsx(s.img, loaded && s.imgLoaded)}
    />
  );
}

export function PostCardImages({ images, compact, expanded, onOpen }: Props) {
  const { t } = useTranslation();
  if (images.length === 0) return null;

  const galleryClass = (s as Record<string, string>)[`images${images.length}`] ?? s.images1;

  if (compact) {
    const cover = images[0];
    return (
      <div className={s.imageCompact}>
        <button
          type="button"
          className={s.imgWrap}
          onClick={() => onOpen(0)}
          aria-label={t('post.viewImage', { index: 1, total: images.length })}
        >
          <PostImage image={cover} />
        </button>
        {images.length > 1 && !expanded && (
          <span className={s.imageCountOverlay}>+{images.length - 1}</span>
        )}
      </div>
    );
  }

  return (
    <div className={clsx(s.images, galleryClass)}>
      {images.map((img, idx) => {
        // Single-image posts keep their natural aspect ratio, so reserve the
        // exact box from the stored dimensions to eliminate layout shift.
        const reserveRatio =
          images.length === 1 && img.width && img.height
            ? { aspectRatio: `${img.width} / ${img.height}` }
            : undefined;
        return (
          <button
            key={img.url}
            type="button"
            className={s.imgWrap}
            style={reserveRatio}
            onClick={() => onOpen(idx)}
            aria-label={t('post.viewImage', { index: idx + 1, total: images.length })}
          >
            <PostImage image={img} />
          </button>
        );
      })}
    </div>
  );
}

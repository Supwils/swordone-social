import { useEffect } from 'react';

const BASE = 'SwordOne';

/**
 * Per-route document titles. Every page used to share one static tab title,
 * so history, bookmarks, and a row of open tabs were indistinguishable.
 *
 * Pass the page's human name (already translated); empty/undefined falls back
 * to the bare app name. Unmount restores the base so a route that forgets the
 * hook never inherits the previous page's title.
 */
export function usePageTitle(title?: string | null): void {
  useEffect(() => {
    document.title = title ? `${title} · ${BASE}` : BASE;
    return () => {
      document.title = BASE;
    };
  }, [title]);
}

import i18n from '@/i18n';

/**
 * BCP 47 tag for the app's active UI language, for `Intl` / `toLocale*String`.
 * The app language wins over the browser locale so a 中文 UI does not show
 * "Apr 2" dates and an English UI does not show "4月2日".
 */
export function dateLocale(): string {
  return i18n.language?.startsWith('zh') ? 'zh-CN' : 'en-US';
}

/**
 * Format a date as a relative string for recent times, absolute for older.
 * Examples: "just now", "3m", "2h", "Apr 2", "Apr 2, 2024"
 */
export function formatRelative(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diff = (now - d.getTime()) / 1000;

  if (diff < 45) return i18n.t('common.justNow');
  if (diff < 60 * 60) return i18n.t('common.minutesShort', { n: Math.round(diff / 60) });
  if (diff < 60 * 60 * 24) return i18n.t('common.hoursShort', { n: Math.round(diff / 3600) });
  if (diff < 60 * 60 * 24 * 7) return i18n.t('common.daysShort', { n: Math.round(diff / 86400) });

  const currentYear = new Date().getFullYear();
  const sameYear = d.getFullYear() === currentYear;
  return d.toLocaleDateString(dateLocale(), {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export function formatAbsolute(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(dateLocale(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

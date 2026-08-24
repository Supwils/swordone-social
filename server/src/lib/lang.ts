import type { Request } from 'express';
import { z } from 'zod';

/**
 * The two locales the app ships. Every place that turns a request into a
 * translation target goes through here, so an arbitrary `lang=xx` can never
 * reach the paid Translate API or be persisted as a new `translations` key.
 */
export const LOCALES = ['en', 'zh'] as const;
export type Locale = (typeof LOCALES)[number];
export const localeSchema = z.enum(LOCALES);

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'zh';
}

/** Any CJK ideograph makes the text Chinese; everything else counts as English. */
export function detectLang(text: string): Locale {
  return /[\u4e00-\u9fff]/.test(text) ? 'zh' : 'en';
}

/** Signed-in preference first, then `?lang=`, then English. */
export function resolveLang(req: Request): Locale {
  const pref = req.user?.preferences?.language;
  if (isLocale(pref)) return pref;
  const q = req.query?.lang;
  return isLocale(q) ? q : 'en';
}

/**
 * Whether post/comment BODIES should be translated on read. A signed-in user
 * can switch it off (X-style per-post translate stays available); anonymous
 * readers always get the auto path — they have no preference to store.
 */
export function autoTranslateOn(req: Request): boolean {
  return req.user?.preferences?.autoTranslate !== false;
}

import type { Request } from 'express';
import type { Locale } from '../contract/common';

/**
 * The two locales the app ships live in the contract (`LOCALES`). Every place
 * that turns a request into a translation target goes through here, so an
 * arbitrary `lang=xx` can never reach the paid Translate API or be persisted as
 * a new `translations` key.
 */
export { localeSchema, type Locale } from '../contract/common';

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
  if (readsOriginal(req)) return false;
  return req.user?.preferences?.autoTranslate !== false;
}

/**
 * A first-party agent (`isAgent`, no owner) — the Era 3 roster — always reads
 * ORIGINAL text: no body, comment or tag translation on any read. Its feed is
 * experiment input: an agent sends no `lang`, the fallback is `'en'`, and with
 * a Translate key configured every Chinese post used to reach the prompt as an
 * English translation. BYOA (owned) agents and humans keep their preference.
 */
export function readsOriginal(req: Request): boolean {
  return Boolean(req.user?.isAgent && !req.user.ownerId);
}

/** How a read should translate what it returns: target language + whether bodies auto-translate. */
export interface ReadTranslation {
  lang: Locale;
  content: boolean;
}

/**
 * `resolveLang` + `autoTranslateOn` in one value — or null when the request
 * must get originals (`readsOriginal`). Every translating read goes through this.
 */
export function readTranslation(req: Request): ReadTranslation | null {
  if (readsOriginal(req)) return null;
  return { lang: resolveLang(req), content: autoTranslateOn(req) };
}

/** The language a tag display is rendered in: undefined (the stored display) for `readsOriginal`. */
export function tagLang(req: Request): Locale | undefined {
  return readTranslation(req)?.lang;
}

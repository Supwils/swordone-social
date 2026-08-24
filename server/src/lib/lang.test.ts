import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { autoTranslateOn, detectLang, isLocale, resolveLang } from './lang';

function req(over: { user?: unknown; query?: Record<string, unknown> } = {}): Request {
  return { query: {}, ...over } as unknown as Request;
}

describe('lang helpers', () => {
  it('detects Chinese by any CJK ideograph, everything else is English', () => {
    expect(detectLang('你好')).toBe('zh');
    expect(detectLang('mostly english with one 字')).toBe('zh');
    expect(detectLang('plain english')).toBe('en');
    expect(detectLang('')).toBe('en');
    expect(detectLang('こんにちは')).toBe('en'); // kana is not a shipped locale
  });

  it('isLocale accepts only the two shipped locales', () => {
    expect(isLocale('en')).toBe(true);
    expect(isLocale('zh')).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });

  it('resolveLang: signed-in preference beats ?lang, which beats the English default', () => {
    expect(resolveLang(req({ user: { preferences: { language: 'zh' } }, query: { lang: 'en' } }))).toBe(
      'zh',
    );
    expect(resolveLang(req({ query: { lang: 'zh' } }))).toBe('zh');
    expect(resolveLang(req())).toBe('en');
  });

  it('resolveLang never lets an unknown language through to the paid API', () => {
    expect(resolveLang(req({ query: { lang: 'fr' } }))).toBe('en');
    expect(resolveLang(req({ user: { preferences: { language: 'xx' } }, query: { lang: 'zh' } }))).toBe(
      'zh',
    );
  });

  it('autoTranslateOn is on unless a signed-in user turned it off', () => {
    expect(autoTranslateOn(req())).toBe(true);
    expect(autoTranslateOn(req({ user: { preferences: {} } }))).toBe(true);
    expect(autoTranslateOn(req({ user: { preferences: { autoTranslate: false } } }))).toBe(false);
  });
});

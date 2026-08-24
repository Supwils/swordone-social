import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import zh from './locales/zh.json';

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    zh: { translation: zh },
  },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

/**
 * Keep `<html lang>` in step with the active language. index.html ships
 * `lang="en"`; without this, switching to 中文 leaves screen readers, CJK font
 * fallback and hyphenation on the English setting.
 */
function syncDocumentLang(lng: string): void {
  if (typeof document !== 'undefined') document.documentElement.lang = lng;
}
syncDocumentLang(i18n.language);
i18n.on('languageChanged', syncDocumentLang);

export default i18n;

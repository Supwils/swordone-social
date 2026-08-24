import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import i18n from '@/i18n';

export type ThemePreference = 'system' | 'light' | 'dark';
export type LanguagePreference = 'en' | 'zh';
export type FeedLayout = 'list' | 'grid' | 'immersive';

interface UIState {
  theme: ThemePreference;
  language: LanguagePreference;
  sidebarCollapsed: boolean;
  feedLayout: FeedLayout;
  cmdkOpen: boolean;

  setTheme: (t: ThemePreference) => void;
  setLanguage: (l: LanguagePreference) => void;
  toggleSidebar: () => void;
  setFeedLayout: (l: FeedLayout) => void;
  openCmdK: () => void;
  closeCmdK: () => void;
}

export const useUI = create<UIState>()(
  persist(
    (set) => ({
      theme: 'system',
      language: 'en',
      sidebarCollapsed: false,
      // Folio (two compact cards in view) is the default so a scroll shows
      // more than one post. List remains the 680px reading column.
      feedLayout: 'grid',
      cmdkOpen: false,

      setTheme: (theme) => set({ theme }),
      setLanguage: (language) => {
        set({ language });
        void i18n.changeLanguage(language);
      },
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setFeedLayout: (feedLayout) => set({ feedLayout }),
      openCmdK: () => set({ cmdkOpen: true }),
      closeCmdK: () => set({ cmdkOpen: false }),
    }),
    {
      name: 'swil.ui',
      version: 2,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        theme: s.theme,
        language: s.language,
        sidebarCollapsed: s.sidebarCollapsed,
        feedLayout: s.feedLayout,
      }),
      migrate: (persisted, from) => {
        const p = (persisted ?? {}) as Partial<UIState>;
        // v2: folio is the default. Keep theme/language/sidebar.
        if (from < 2) return { ...p, feedLayout: 'grid' as const };
        return p;
      },
      onRehydrateStorage: () => (state) => {
        if (state?.language) void i18n.changeLanguage(state.language);
      },
    },
  ),
);

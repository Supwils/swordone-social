import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import * as usersApi from '@/api/users.api';
import { invalidatePostReads } from '@/features/posts/postCache';
import { useSession } from '@/stores/session.store';
import { useUI, type LanguagePreference } from '@/stores/ui.store';

/**
 * The one way to switch language. For a signed-in reader it must also persist:
 * the server picks the translation target from `preferences.language` before
 * it looks at `?lang=` (see `server/src/lib/lang.ts`), so a local-only switch
 * leaves post bodies in the old language, and `AuthBootstrap` pulls the stale
 * preference back over the UI on the next load.
 *
 * The write is awaited BEFORE the UI language flips. Post and comment queries
 * are keyed on the UI language, so flipping first refetched every visible list
 * while the server still held the old preference — and cached the old
 * language's bodies under the new language's key.
 *
 * Anonymous surfaces (showcase, login) can call this too — with no session
 * there is nothing to store, and `?lang=` is what the server reads anyway.
 */
export function useSetLanguage(): (lang: LanguagePreference) => Promise<void> {
  const setLanguage = useUI((st) => st.setLanguage);
  const setUser = useSession((st) => st.setUser);
  const userId = useSession((st) => st.user?.id);
  const qc = useQueryClient();

  return useCallback(
    async (lang: LanguagePreference) => {
      if (!userId) {
        setLanguage(lang);
        return;
      }
      // A failed write must not block the UI from switching.
      const updated = await usersApi
        .updateMe({ preferences: { language: lang } })
        .catch(() => null);
      if (updated && useSession.getState().user?.id === updated.id) setUser(updated);
      setLanguage(lang);
      // The server still holds the old preference, so whatever the new keys
      // fetched (or already hold) may be old-language bodies: mark them stale
      // so the next read — after a later successful write or reload — replaces them.
      if (!updated) invalidatePostReads(qc);
    },
    [setLanguage, setUser, userId, qc],
  );
}

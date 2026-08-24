import { useCallback } from 'react';
import * as usersApi from '@/api/users.api';
import { useSession } from '@/stores/session.store';
import { useUI, type LanguagePreference } from '@/stores/ui.store';

/**
 * The one way to switch language. For a signed-in reader it must also persist:
 * the server picks the translation target from `preferences.language` before
 * it looks at `?lang=` (see `server/src/lib/lang.ts`), so a local-only switch
 * leaves post bodies in the old language, and `AuthBootstrap` pulls the stale
 * preference back over the UI on the next load.
 *
 * Anonymous surfaces (showcase, login) can call this too — with no session
 * there is nothing to store, and `?lang=` is what the server reads anyway.
 */
export function useSetLanguage(): (lang: LanguagePreference) => void {
  const setLanguage = useUI((st) => st.setLanguage);
  const user = useSession((st) => st.user);

  return useCallback(
    (lang: LanguagePreference) => {
      setLanguage(lang);
      if (!user) return;
      // Fire-and-forget: a failed write must not block the UI from switching.
      void usersApi.updateMe({ preferences: { language: lang } }).catch(() => undefined);
    },
    [setLanguage, user],
  );
}

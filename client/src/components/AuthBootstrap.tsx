import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/stores/session.store';
import { onUnauthorized } from '@/api/client';
import * as authApi from '@/api/auth.api';
import { useUI } from '@/stores/ui.store';
import { applyTheme, watchSystemTheme } from '@/lib/applyTheme';
import { applyNoSession, applySession, endSession } from '@/lib/session';

/**
 * One-time app bootstrap:
 *  - Calls /auth/me, hydrates session store
 *  - Wires 401 interceptor to clear the session
 *  - Applies theme and watches system changes
 */
export function AuthBootstrap() {
  const setUser = useSession((s) => s.setUser);
  const markReady = useSession((s) => s.markReady);
  const qc = useQueryClient();
  const theme = useUI((s) => s.theme);

  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'system') return;
    return watchSystemTheme(() => applyTheme(theme));
  }, [theme]);

  useEffect(() => {
    onUnauthorized(() => {
      // Anonymous /auth/me is a 401 by design. Clearing the cache there
      // (or on an anonymous like) wipes the public feed the user is reading.
      if (!useSession.getState().user) return;
      endSession(qc);
    });
  }, [qc]);

  useEffect(() => {
    let active = true;
    authApi
      .me()
      .then((user) => {
        if (!active) return;
        if (user) applySession(qc, user);
        else applyNoSession();
      })
      .catch(() => {
        if (!active) return;
        setUser(null);
      })
      .finally(() => {
        if (active) markReady();
      });
    return () => {
      active = false;
    };
  }, [setUser, markReady, qc]);

  return null;
}

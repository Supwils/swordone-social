import type { QueryClient } from '@tanstack/react-query';
import { qk } from '@/api/queryKeys';
import type { UserDTO } from '@/api/types';
import { invalidatePostReads } from '@/features/posts/postCache';
import { useDrafts } from '@/stores/draft.store';
import { useSession } from '@/stores/session.store';
import { useUI } from '@/stores/ui.store';

/**
 * A session began or was confirmed (bootstrap `/auth/me`, login, register).
 * One path, so every entry point also applies the account's stored language —
 * login used to skip it, leaving the UI in whatever the last visitor chose —
 * and hands the drafts store to this account.
 */
export function applySession(qc: QueryClient, user: UserDTO): void {
  useDrafts.getState().claim(user.id);
  useSession.getState().setUser(user);
  qc.setQueryData(qk.auth.me, user);
  const lang = user.preferences?.language;
  if (lang && lang !== useUI.getState().language) {
    useUI.getState().setLanguage(lang);
    // Reads already in flight were answered in the stored language but are
    // cached under the previous UI language's key.
    invalidatePostReads(qc);
  }
}

/**
 * Bootstrap found no session (`/auth/me` → null). If the cookie expired while
 * the tab was closed, `endSession` never ran, so drop the drafts here too.
 */
export function applyNoSession(): void {
  useSession.getState().setUser(null);
  useDrafts.getState().clearAll();
}

/**
 * A session ended (sign-out, or a 401 on a signed-in request). Drops the user,
 * every cached query and every composer draft: drafts are per-device text an
 * account typed, and must not survive into the next account on this browser.
 */
export function endSession(qc: QueryClient): void {
  useSession.getState().clear();
  qc.clear();
  useDrafts.getState().clearAll();
}

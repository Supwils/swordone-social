import { useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { useSession } from '@/stores/session.store';
import { useAuthPrompt, type AuthPromptReason } from '@/stores/authPrompt.store';

/**
 * Wraps a write action: a member runs it, a guest gets the sign-in prompt.
 *
 *   const gate = useAuthGate();
 *   <button onClick={() => gate('like', () => like.mutate())} />
 */
export function useAuthGate() {
  const user = useSession((st) => st.user);
  const open = useAuthPrompt((st) => st.open);
  return useCallback(
    (reason: AuthPromptReason, action: () => void) => {
      if (user) action();
      else open(reason);
    },
    [user, open],
  );
}

/**
 * Router state for a sign-in link, so login returns the visitor to the page
 * they were reading instead of dropping them on /feed.
 */
export function useReturnState(): { from: string } {
  const { pathname, search } = useLocation();
  return { from: pathname + search };
}

/**
 * Accepts only an in-app path. Location state is not attacker-reachable from a
 * URL, but `//host` and absolute URLs are refused anyway so a future caller
 * that builds `from` from a query string cannot turn login into an open
 * redirect.
 */
export function safeReturnPath(from: unknown, fallback: string): string {
  if (typeof from !== 'string') return fallback;
  if (!from.startsWith('/') || from.startsWith('//') || from.startsWith('/\\')) return fallback;
  if (from === '/login' || from === '/register') return fallback;
  return from;
}

import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import * as authApi from '@/api/auth.api';
import { endSession } from '@/lib/session';

/**
 * Sign out: ask the server to drop the cookie (best-effort), then end the
 * local session through the one `endSession` path and land on /login. Shared
 * by the desktop sidebar and the mobile "more" sheet.
 */
export function useLogout(): () => Promise<void> {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const nav = useNavigate();
  return async () => {
    try {
      await authApi.logout();
    } catch {
      // Server-side logout is best-effort — the local session clears either way.
    } finally {
      endSession(qc);
      toast.success(t('nav.signedOut'));
      nav('/login');
    }
  };
}

import { create } from 'zustand';

/** The action a signed-out visitor tried to take; picks the prompt's title. */
export type AuthPromptReason = 'like' | 'echo' | 'bookmark' | 'follow' | 'message';

interface AuthPromptState {
  reason: AuthPromptReason | null;
  open: (reason: AuthPromptReason) => void;
  close: () => void;
}

/**
 * One sign-in prompt for the whole app. Guests can read every open surface, so
 * the write affordances stay visible to them (a hidden like button teaches
 * nothing); clicking one opens this prompt instead of firing a request that
 * would only come back 401.
 */
export const useAuthPrompt = create<AuthPromptState>()((set) => ({
  reason: null,
  open: (reason) => set({ reason }),
  close: () => set({ reason: null }),
}));

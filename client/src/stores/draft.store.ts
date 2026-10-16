import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface Draft {
  text: string;
  updatedAt: number;
}

interface DraftState {
  drafts: Record<string, Draft>;
  /** The account the stored drafts were typed by; `null` = nobody yet. */
  ownerId: string | null;
  getDraft: (key: string) => Draft | undefined;
  setDraft: (key: string, text: string) => void;
  clearDraft: (key: string) => void;
  clearAll: () => void;
  /**
   * A session for `userId` began. Drafts typed by anyone else (or by an
   * unknown owner) are dropped: a cookie that expired while the tab was closed
   * never runs `endSession`, so the next account would otherwise inherit them.
   */
  claim: (userId: string) => void;
}

/** A draft untouched this long is dropped when the store rehydrates. */
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Keep only drafts written within the TTL. */
export function pruneDrafts(drafts: Record<string, Draft>, now: number): Record<string, Draft> {
  const out: Record<string, Draft> = {};
  for (const [key, draft] of Object.entries(drafts)) {
    if (draft && typeof draft.updatedAt === 'number' && now - draft.updatedAt < DRAFT_TTL_MS) {
      out[key] = draft;
    }
  }
  return out;
}

// Rehydration does not persist what `merge` returns, so pruned drafts would
// stay in localStorage forever. `merge` flags a prune; the post-rehydrate
// callback writes back through the creator's (persisting) `set`. Both run
// synchronously inside `create`, before `useDrafts` itself is assigned.
let prunedOnHydrate = false;
let persistDrafts: ((drafts: Record<string, Draft>) => void) | null = null;

/**
 * Stores composer drafts keyed by context (`post.new`, `comment.<postId>`).
 * Survives reloads, expires after `DRAFT_TTL_MS`, is wiped when a session
 * ends (`lib/session.ts` `endSession`) and when a different account's session
 * begins (`claim`). Auto-save throttle is the caller's responsibility.
 */
export const useDrafts = create<DraftState>()(
  persist(
    (set, get) => {
      persistDrafts = (drafts) => set({ drafts });
      return {
        drafts: {},
        ownerId: null,
        getDraft: (key) => get().drafts[key],
        setDraft: (key, text) =>
          set((s) => ({
            drafts: { ...s.drafts, [key]: { text, updatedAt: Date.now() } },
          })),
        clearDraft: (key) => {
          // Every mounted comment box clears its (usually absent) draft; a
          // `set` here would still persist, i.e. one localStorage write per
          // card on every feed page.
          if (!(key in get().drafts)) return;
          set((s) => {
            const { [key]: _removed, ...rest } = s.drafts;
            return { drafts: rest };
          });
        },
        clearAll: () => {
          const s = get();
          if (Object.keys(s.drafts).length === 0 && s.ownerId === null) return;
          set({ drafts: {}, ownerId: null });
        },
        claim: (userId) => {
          if (get().ownerId === userId) return;
          set({ drafts: {}, ownerId: userId });
        },
      };
    },
    {
      name: 'swil.drafts',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ drafts: s.drafts, ownerId: s.ownerId }),
      merge: (persisted, current) => {
        const p = (persisted as Partial<DraftState> | undefined) ?? {};
        const stored = p.drafts ?? {};
        const drafts = pruneDrafts(stored, Date.now());
        prunedOnHydrate = Object.keys(drafts).length !== Object.keys(stored).length;
        return { ...current, drafts, ownerId: p.ownerId ?? null };
      },
      onRehydrateStorage: () => (state) => {
        if (!state || !prunedOnHydrate) return;
        prunedOnHydrate = false;
        persistDrafts?.(state.drafts);
      },
    },
  ),
);

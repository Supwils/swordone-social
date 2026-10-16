import { create } from 'zustand';

interface RealtimeState {
  connected: boolean;
  unreadNotifications: number;
  unreadConversations: number;
  newFeedPostCount: number;

  setConnected: (v: boolean) => void;
  setUnreadNotifications: (n: number) => void;
  incUnreadNotifications: (delta?: number) => void;
  decUnreadNotifications: (delta?: number) => void;
  setUnreadConversations: (n: number) => void;
  incUnreadConversations: (delta?: number) => void;
  incNewFeedPostCount: () => void;
  resetNewFeedPostCount: () => void;
}

export const useRealtime = create<RealtimeState>((set) => ({
  connected: false,
  unreadNotifications: 0,
  unreadConversations: 0,
  newFeedPostCount: 0,

  setConnected: (connected) => set({ connected }),
  setUnreadNotifications: (n) => set({ unreadNotifications: Math.max(0, n) }),
  incUnreadNotifications: (delta = 1) =>
    set((s) => ({ unreadNotifications: s.unreadNotifications + delta })),
  decUnreadNotifications: (delta = 1) =>
    set((s) => ({ unreadNotifications: Math.max(0, s.unreadNotifications - delta) })),
  setUnreadConversations: (n) => set({ unreadConversations: Math.max(0, n) }),
  incUnreadConversations: (delta = 1) =>
    set((s) => ({ unreadConversations: Math.max(0, s.unreadConversations + delta) })),
  incNewFeedPostCount: () => set((s) => ({ newFeedPostCount: s.newFeedPostCount + 1 })),
  resetNewFeedPostCount: () => set({ newFeedPostCount: 0 }),
}));

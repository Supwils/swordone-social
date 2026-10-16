/**
 * Centralized TanStack Query keys.
 * Keeping these in one place prevents invalidation drift and typos.
 */
export const qk = {
  auth: {
    me: ['auth', 'me'] as const,
  },
  users: {
    byUsername: (username: string) => ['users', username] as const,
    posts: (username: string) => ['users', username, 'posts'] as const,
    following: (username: string) => ['users', username, 'following'] as const,
    followers: (username: string) => ['users', username, 'followers'] as const,
    followStatus: (username: string) => ['users', username, 'follow-status'] as const,
    search: (q: string) => ['users', 'search', q] as const,
  },
  posts: {
    // Bodies are translated on read, so the language is part of the identity
    // of the cached post, exactly as it already is for comments.
    byId: (id: string, lang?: string) => ['posts', id, 'detail', lang ?? 'en'] as const,
    comments: (id: string, lang?: string) => ['posts', id, 'comments', lang ?? 'en'] as const,
  },
  bookmarks: {
    list: ['bookmarks'] as const,
  },
  myAgents: {
    list: ['my-agents'] as const,
  },
  feed: {
    following: (lang?: string, sort?: string) =>
      ['feed', 'following', lang ?? 'en', sort ?? 'recommended'] as const,
    global: (lang?: string, sort?: string) =>
      ['feed', 'global', lang ?? 'en', sort ?? 'recommended'] as const,
    byTag: (slug: string, lang?: string) => ['feed', 'tag', slug, lang ?? 'en'] as const,
    byBoard: (slug: string, lang?: string) => ['feed', 'board', slug, lang ?? 'en'] as const,
  },
  tags: {
    trending: ['tags', 'trending'] as const,
    bySlug: (slug: string) => ['tags', slug] as const,
  },
  boards: {
    list: ['boards', 'list'] as const,
    bySlug: (slug: string) => ['boards', slug] as const,
  },
  notifications: {
    list: ['notifications', 'list'] as const,
    unreadCount: ['notifications', 'unread-count'] as const,
  },
  conversations: {
    list: ['conversations', 'list'] as const,
    unreadCount: ['conversations', 'unread-count'] as const,
    byId: (id: string) => ['conversations', id] as const,
    messages: (id: string) => ['conversations', id, 'messages'] as const,
  },
};

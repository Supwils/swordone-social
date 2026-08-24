import type { MessageDTO, Paginated } from '@/api/types';

/** Shape TanStack Query stores for `qk.conversations.messages(id)`. */
export interface MessagePages {
  pages: Paginated<MessageDTO>[];
  pageParams: unknown[];
}

/**
 * Prepend a message to the newest page, ignoring one that is already there.
 *
 * Two writers race for this cache and both can win. `messages.service.ts`
 * emits the socket frame BEFORE it awaits the recipients' notification writes,
 * so the sender — who is in the conversation room — normally receives their own
 * message over the socket before the POST's 201 comes back. `RealtimeBridge`
 * carried this dedupe and the send handler did not, so the sender's own bubble
 * rendered twice (with a duplicate React key) until the query refetched.
 *
 * Callers keep their own "no cache yet" behaviour: the bridge must not
 * materialise a cache for a thread nobody is looking at; the sender must.
 */
export function prependMessage(old: MessagePages, msg: MessageDTO): MessagePages {
  if (old.pages.some((pg) => pg.items.some((m) => m.id === msg.id))) return old;
  const [first, ...rest] = old.pages;
  if (!first) return old;
  return { ...old, pages: [{ ...first, items: [msg, ...first.items] }, ...rest] };
}

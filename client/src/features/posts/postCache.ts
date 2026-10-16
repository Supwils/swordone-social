import type { InfiniteData, QueryClient, QueryFilters } from '@tanstack/react-query';
import { qk } from '@/api/queryKeys';
import type { Paginated, PostDTO } from '@/api/types';
import type { PostCore } from '@/contract';

/**
 * The one owner of "which caches can hold a post". Every post mutation (like,
 * bookmark, edit, delete, comment count, new post / echo) goes through here, so
 * a card rendered from any list — feed, profile, bookmarks, search, detail —
 * sees the change. Four hand-rolled patchers with four different key lists
 * left stale cards on whichever surfaces each one forgot.
 */

type PostPages = InfiniteData<Paginated<PostDTO>>;

/** `['users', <username>, 'posts', <lang>]` — a profile's post list. */
function isUserPostsKey(key: readonly unknown[]): boolean {
  return key[0] === 'users' && key[2] === 'posts';
}

/** Every infinite list of posts, across languages and sorts. */
const POST_LISTS: QueryFilters[] = [
  { queryKey: ['feed'] },
  { queryKey: qk.bookmarks.all },
  { queryKey: ['posts', 'search'] },
  { predicate: (q) => isUserPostsKey(q.queryKey) },
];

/** Every language's detail copy of one post. */
function detailFilter(id: string): QueryFilters {
  return { queryKey: ['posts', id, 'detail'] };
}

type Patch = Partial<PostDTO> | ((post: PostDTO) => PostDTO);

function applyPatch(post: PostDTO, patch: Patch): PostDTO {
  return typeof patch === 'function' ? patch(post) : { ...post, ...patch };
}

function mapPages(old: PostPages | undefined, fn: (items: PostDTO[]) => PostDTO[]) {
  if (!old?.pages) return old;
  return { ...old, pages: old.pages.map((pg) => ({ ...pg, items: fn(pg.items ?? []) })) };
}

/** Every post's detail copy, any language: `['posts', <id>, 'detail', <lang>]`. */
const ANY_DETAIL: QueryFilters = {
  predicate: (q) => q.queryKey[0] === 'posts' && q.queryKey[2] === 'detail',
};

/** The explore summary carries a featured post. */
const EXPLORE_SUMMARY = { queryKey: ['explore-summary'] } as const;

/** Patched copy of an embedded original (`echoOf`), which never has its own `echoOf`. */
function patchCore(core: PostCore, patch: Patch): PostCore {
  const { echoOf: _drop, ...rest } = applyPatch(core as PostDTO, patch);
  return rest;
}

/**
 * The tombstone the server itself renders for a deleted original
 * (`server/src/lib/dto.ts` `toPostDTO`): body `[deleted]`, no translation,
 * fixed `en`, no media, no edit stamp. Attribution and counts stay.
 */
function tombstone(core: PostCore): PostCore {
  const { originalText: _t, originalLang: _l, ...rest } = core;
  return { ...rest, text: '[deleted]', lang: 'en', images: [], video: null, editedAt: null };
}

/** Rewrite one post, and every echo card's embedded copy of it. */
function mapPost(
  p: PostDTO,
  id: string,
  onSelf: (p: PostDTO) => PostDTO,
  onEmbedded: (c: PostCore) => PostCore,
): PostDTO {
  const self = p.id === id ? onSelf(p) : p;
  return self.echoOf?.id === id ? { ...self, echoOf: onEmbedded(self.echoOf) } : self;
}

/** Apply a patch to one post wherever it is cached, echo cards' embedded copies included. */
export function patchPost(qc: QueryClient, id: string, patch: Patch): void {
  const fix = (p: PostDTO) =>
    mapPost(
      p,
      id,
      (self) => applyPatch(self, patch),
      (core) => patchCore(core, patch),
    );
  for (const filter of POST_LISTS) {
    qc.setQueriesData<PostPages>(filter, (old) => mapPages(old, (items) => items.map(fix)));
  }
  qc.setQueriesData<PostDTO>(ANY_DETAIL, (old) => {
    if (!old) return old;
    const next = fix(old);
    // `undefined` leaves an untouched detail as it was (no fresh timestamp).
    return next === old ? undefined : next;
  });
}

/**
 * A post is gone: drop it from every list, forget its detail + comments, and
 * tombstone it inside every echo of it (the server does the same on read).
 */
export function dropPost(qc: QueryClient, id: string): void {
  const fix = (p: PostDTO) => mapPost(p, id, (self) => self, tombstone);
  for (const filter of POST_LISTS) {
    qc.setQueriesData<PostPages>(filter, (old) =>
      mapPages(old, (items) => items.filter((p) => p.id !== id).map(fix)),
    );
  }
  qc.removeQueries({ queryKey: ['posts', id] });
  qc.setQueriesData<PostDTO>(ANY_DETAIL, (old) => {
    if (!old) return old;
    const next = fix(old);
    // `undefined` leaves an untouched detail as it was (no fresh timestamp).
    return next === old ? undefined : next;
  });
  void qc.invalidateQueries(EXPLORE_SUMMARY);
}

/** Move a post's comment count, clamped at zero. */
export function bumpCommentCount(qc: QueryClient, id: string, delta: 1 | -1): void {
  patchPost(qc, id, (p) => ({ ...p, commentCount: Math.max(0, p.commentCount + delta) }));
}

/**
 * Refetch every post list (and the showcase): a new post or echo belongs in
 * lists nobody can patch by hand, such as the author's own profile, and an
 * echo moves the original's `echoCount` wherever it is shown.
 */
export function invalidatePostLists(qc: QueryClient): void {
  for (const filter of POST_LISTS) void qc.invalidateQueries(filter);
  void qc.invalidateQueries({ queryKey: ['showcase'] });
  void qc.invalidateQueries(EXPLORE_SUMMARY);
}

/**
 * Every post and comment body read: all lists plus everything under
 * ['posts'] (details, comment threads, search). Used when cached bodies may be
 * in the wrong language for their key.
 */
export function invalidatePostReads(qc: QueryClient): void {
  invalidatePostLists(qc);
  void qc.invalidateQueries({ queryKey: ['posts'] });
}

/** Refetch every language's detail copy of one post. */
export function invalidatePost(qc: QueryClient, id: string): void {
  void qc.invalidateQueries(detailFilter(id));
}

/**
 * Flatten infinite pages, first occurrence of an id wins. The recommended
 * sort pages by a score that moves between requests (server pagination is
 * best-effort there), so a post can come back on a later page; rendering it
 * twice would also give React two siblings with one key.
 */
export function flattenPostPages(data: PostPages | undefined): PostDTO[] {
  if (!data) return [];
  const seen = new Set<string>();
  const out: PostDTO[] = [];
  for (const page of data.pages) {
    for (const post of page.items) {
      if (seen.has(post.id)) continue;
      seen.add(post.id);
      out.push(post);
    }
  }
  return out;
}

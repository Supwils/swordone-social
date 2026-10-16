import { describe, expect, it } from 'vitest';
import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import { qk } from '@/api/queryKeys';
import type { Paginated, PostDTO } from '@/api/types';
import { makePost } from '@/test/fixtures';
import {
  bumpCommentCount,
  dropPost,
  flattenPostPages,
  invalidatePostLists,
  patchPost,
} from './postCache';

type Pages = InfiniteData<Paginated<PostDTO>>;

const ID = '64b7f0c2a1d3e4f5a6b7c8d9';
const OTHER = '64b7f0c2a1d3e4f5a6b7c8d0';

function pages(...items: PostDTO[][]): Pages {
  return {
    pages: items.map((page, i) => ({ items: page, nextCursor: i < items.length - 1 ? 'c' : null })),
    pageParams: items.map((_, i) => (i === 0 ? null : 'c')),
  };
}

/** Every list key a card can be rendered from, in two languages where keyed. */
const LIST_KEYS = [
  qk.feed.global('en', 'recommended'),
  qk.feed.following('zh', 'latest'),
  qk.feed.byTag('garden', 'en'),
  qk.bookmarks.list('en'),
  qk.bookmarks.list('zh'),
  qk.posts.search('basil', 'en'),
  qk.users.posts('qiusai', 'en'),
  qk.users.posts('qiusai', 'zh'),
];

function seeded() {
  const qc = new QueryClient();
  const target = makePost({ id: ID, likeCount: 3, commentCount: 1 });
  const other = makePost({ id: OTHER });
  for (const key of LIST_KEYS) qc.setQueryData(key, pages([target, other]));
  qc.setQueryData(qk.posts.byId(ID, 'en'), target);
  qc.setQueryData(qk.posts.byId(ID, 'zh'), target);
  qc.setQueryData(qk.posts.comments(ID, 'en'), pages([]));
  return qc;
}

const itemsAt = (qc: QueryClient, key: readonly unknown[]) =>
  qc.getQueryData<Pages>(key)?.pages.flatMap((p) => p.items) ?? [];

describe('postCache', () => {
  it('patchPost reaches every list and every language of the detail', () => {
    const qc = seeded();

    patchPost(qc, ID, { likedByMe: true, likeCount: 4 });

    for (const key of LIST_KEYS) {
      const hit = itemsAt(qc, key).find((p) => p.id === ID);
      expect(hit?.likeCount, JSON.stringify(key)).toBe(4);
      expect(itemsAt(qc, key).find((p) => p.id === OTHER)?.likeCount).toBe(0);
    }
    for (const lang of ['en', 'zh']) {
      expect(qc.getQueryData<PostDTO>(qk.posts.byId(ID, lang))?.likedByMe).toBe(true);
    }
  });

  it('dropPost removes it from every list, bookmarks included, and forgets its detail', () => {
    // Delete from /bookmarks or search used to leave the card on screen.
    const qc = seeded();

    dropPost(qc, ID);

    for (const key of LIST_KEYS) {
      expect(
        itemsAt(qc, key).map((p) => p.id),
        JSON.stringify(key),
      ).toEqual([OTHER]);
    }
    expect(qc.getQueryData(qk.posts.byId(ID, 'en'))).toBeUndefined();
    expect(qc.getQueryData(qk.posts.comments(ID, 'en'))).toBeUndefined();
  });

  it('bumpCommentCount moves the detail copy too and never goes below zero', () => {
    // Commenting on /p/:id left the detail's commentCount stale.
    const qc = seeded();

    bumpCommentCount(qc, ID, 1);
    expect(qc.getQueryData<PostDTO>(qk.posts.byId(ID, 'en'))?.commentCount).toBe(2);
    expect(itemsAt(qc, qk.bookmarks.list('en')).find((p) => p.id === ID)?.commentCount).toBe(2);

    bumpCommentCount(qc, ID, -1);
    bumpCommentCount(qc, ID, -1);
    bumpCommentCount(qc, ID, -1);
    expect(qc.getQueryData<PostDTO>(qk.posts.byId(ID, 'en'))?.commentCount).toBe(0);
  });

  it('invalidatePostLists marks the author profile list stale, not just the feed', () => {
    // A new post or echo was missing from the author's own profile for 30 s.
    const qc = seeded();
    qc.setQueryData(qk.users.byUsername('qiusai'), { id: 'u' });

    invalidatePostLists(qc);

    for (const key of LIST_KEYS) {
      expect(qc.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true);
    }
    // A profile itself is not a post list.
    expect(qc.getQueryState(qk.users.byUsername('qiusai'))?.isInvalidated).toBe(false);
  });

  it('flattenPostPages keeps the first occurrence of a post that came back on a later page', () => {
    // The recommended sort pages by a score that moves between requests.
    const a = makePost({ id: ID, text: 'first' });
    const b = makePost({ id: OTHER });
    const aAgain = makePost({ id: ID, text: 'second' });

    const out = flattenPostPages(pages([a], [aAgain, b]));

    expect(out.map((p) => p.id)).toEqual([ID, OTHER]);
    expect(out[0].text).toBe('first');
    expect(flattenPostPages(undefined)).toEqual([]);
  });
});

describe('postCache — echo cards and the explore summary', () => {
  const ECHO = '64b7f0c2a1d3e4f5a6b7c8d1';

  function withEcho() {
    const qc = new QueryClient();
    const original = makePost({ id: ID, text: 'the original', likeCount: 1 });
    const { echoOf: _none, ...core } = original;
    const echo = makePost({ id: ECHO, text: 'my echo', echoOf: core });
    qc.setQueryData(qk.feed.global('en', 'recommended'), pages([echo]));
    qc.setQueryData(qk.posts.byId(ECHO, 'en'), echo);
    qc.setQueryData(['explore-summary', 'en'], { featuredPost: original });
    return qc;
  }

  const embedded = (qc: QueryClient) => itemsAt(qc, qk.feed.global('en', 'recommended'))[0]?.echoOf;

  it('patchPost also patches the copy embedded in an echo card', () => {
    const qc = withEcho();

    patchPost(qc, ID, { likeCount: 2, likedByMe: true });

    expect(embedded(qc)?.likeCount).toBe(2);
    expect(qc.getQueryData<PostDTO>(qk.posts.byId(ECHO, 'en'))?.echoOf?.likeCount).toBe(2);
    // The echo itself is a different post.
    expect(itemsAt(qc, qk.feed.global('en', 'recommended'))[0]?.likeCount).toBe(0);
    expect(embedded(qc)).not.toHaveProperty('echoOf');
  });

  it('dropPost tombstones the original inside its echoes, as the server does', () => {
    const qc = withEcho();

    dropPost(qc, ID);

    const ghost = embedded(qc);
    expect(ghost?.id).toBe(ID);
    expect(ghost?.text).toBe('[deleted]');
    expect(ghost?.images).toEqual([]);
    expect(ghost?.video).toBeNull();
    expect(ghost).not.toHaveProperty('originalText');
    expect(qc.getQueryData<PostDTO>(qk.posts.byId(ECHO, 'en'))?.echoOf?.text).toBe('[deleted]');
    // The echo card stays.
    expect(itemsAt(qc, qk.feed.global('en', 'recommended')).map((p) => p.id)).toEqual([ECHO]);
  });

  it('dropPost and invalidatePostLists refresh the explore summary (it features a post)', () => {
    const qc = withEcho();
    dropPost(qc, ID);
    expect(qc.getQueryState(['explore-summary', 'en'])?.isInvalidated).toBe(true);

    const qc2 = withEcho();
    invalidatePostLists(qc2);
    expect(qc2.getQueryState(['explore-summary', 'en'])?.isInvalidated).toBe(true);
  });
});

describe('query key namespaces', () => {
  it('keeps user search and explore out of the per-username namespace', () => {
    // A real account named `search` had its posts at ['users','search','posts']
    // — the DM user-search key for the query "posts".
    expect(qk.users.search('posts')[0]).not.toBe('users');
    expect(qk.users.explore('ai')[0]).not.toBe('users');
    expect(qk.users.search('posts')).not.toEqual(qk.users.posts('search').slice(0, 3));
  });
});

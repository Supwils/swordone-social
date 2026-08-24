import { describe, expect, it } from 'vitest';
import type { MessageDTO } from '@/api/types';
import { prependMessage, type MessagePages } from './messageCache';

function msg(id: string): MessageDTO {
  return {
    id,
    conversationId: 'c-1',
    sender: {
      id: 'u-1',
      username: 'qiusai',
      usernameDisplay: 'qiusai',
      displayName: '球赛',
      avatarUrl: null,
      headline: '',
      profileTags: [],
      isAgent: false,
    },
    text: `body ${id}`,
    readBy: [],
    createdAt: '2026-08-23T00:00:00.000Z',
  };
}

function pages(...ids: string[][]): MessagePages {
  return { pages: ids.map((page) => ({ items: page.map(msg), nextCursor: null })), pageParams: [] };
}

describe('prependMessage', () => {
  it('puts a new message at the head of the newest page', () => {
    const out = prependMessage(pages(['m2', 'm1']), msg('m3'));
    expect(out.pages[0].items.map((m) => m.id)).toEqual(['m3', 'm2', 'm1']);
  });

  it('ignores a message the cache already holds, whichever page it is on', () => {
    // The real race: the socket frame beats the POST 201, so the send handler
    // is handed a message RealtimeBridge already inserted.
    const before = pages(['m2', 'm1'], ['m0']);

    expect(prependMessage(before, msg('m2'))).toBe(before);
    expect(prependMessage(before, msg('m0'))).toBe(before);
  });

  it('leaves a cache with no pages alone rather than inventing one', () => {
    const empty: MessagePages = { pages: [], pageParams: [] };
    expect(prependMessage(empty, msg('m1'))).toBe(empty);
  });
});

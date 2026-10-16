import { describe, it, expect } from 'vitest';
import { extractTags, extractMentionUsernames } from './extract';

describe('extractTags', () => {
  it('returns empty for plain text', () => {
    expect(extractTags('hello world')).toEqual([]);
  });

  it('extracts a basic ASCII tag', () => {
    expect(extractTags('learning #typescript today')).toEqual([
      { slug: 'typescript', display: 'typescript' },
    ]);
  });

  it('lowercases the slug but preserves display case', () => {
    expect(extractTags('#TypeScript is fun')).toEqual([
      { slug: 'typescript', display: 'TypeScript' },
    ]);
  });

  it('extracts CJK tags', () => {
    expect(extractTags('今天看了 #摄影 和 #设计')).toEqual([
      { slug: '摄影', display: '摄影' },
      { slug: '设计', display: '设计' },
    ]);
  });

  it('dedupes same-slug tags by first occurrence display', () => {
    const tags = extractTags('#AI in #ai applications #Ai everywhere');
    expect(tags).toHaveLength(1);
    expect(tags[0]).toEqual({ slug: 'ai', display: 'AI' });
  });

  it('allows hyphen and underscore but not at start', () => {
    expect(extractTags('#open-source #user_id')).toEqual([
      { slug: 'open-source', display: 'open-source' },
      { slug: 'user_id', display: 'user_id' },
    ]);
  });

  it('caps tag length at 64 characters', () => {
    const long = '#' + 'a'.repeat(70);
    const tags = extractTags(long);
    expect(tags[0].slug.length).toBe(64);
  });

  it('needs a left boundary: no tag inside a word or after another #', () => {
    expect(extractTags('foo#bar')).toEqual([]);
    expect(extractTags('##double')).toEqual([]);
    expect(extractTags('see (#ok) and 看了#摄影')).toEqual([
      { slug: 'ok', display: 'ok' },
      { slug: '摄影', display: '摄影' },
    ]);
  });

  it('does not extract bare # or # followed by punctuation', () => {
    expect(extractTags('# alone')).toEqual([]);
    expect(extractTags('#!alert')).toEqual([]);
  });
});

describe('extractMentionUsernames', () => {
  it('returns empty for plain text', () => {
    expect(extractMentionUsernames('hello world')).toEqual([]);
  });

  it('extracts a basic mention', () => {
    expect(extractMentionUsernames('hi @alice')).toEqual(['alice']);
  });

  it('lowercases mentions', () => {
    expect(extractMentionUsernames('@AliceWonders @bob')).toEqual(['alicewonders', 'bob']);
  });

  it('dedupes duplicate mentions in a single text', () => {
    expect(extractMentionUsernames('@alice and @ALICE')).toEqual(['alice']);
  });

  it('rejects too-short usernames (<3 chars)', () => {
    expect(extractMentionUsernames('@ab is too short, @abc is ok')).toEqual(['abc']);
  });

  it('rejects a name longer than 24 instead of cutting it to 24', () => {
    expect(extractMentionUsernames('@' + 'a'.repeat(30))).toEqual([]);
    expect(extractMentionUsernames('@' + 'a'.repeat(24))).toEqual(['a'.repeat(24)]);
  });

  it('finds no mention inside an email address', () => {
    expect(extractMentionUsernames('contact me at foo@example.com')).toEqual([]);
    expect(extractMentionUsernames('a@bob.com')).toEqual([]);
    expect(extractMentionUsernames('@@alice')).toEqual([]);
  });

  it('ignores non-ASCII names (usernames are ASCII)', () => {
    expect(extractMentionUsernames('你好 @小满')).toEqual([]);
  });

  it('accepts a mention after punctuation or CJK, and before punctuation', () => {
    expect(extractMentionUsernames('(@alice), 你好@bob!')).toEqual(['alice', 'bob']);
  });

  it('handles mixed mentions and tags', () => {
    expect(extractMentionUsernames('hey @alice check out #typescript')).toEqual(['alice']);
  });
});

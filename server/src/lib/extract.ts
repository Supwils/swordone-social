/**
 * Extract #tags and @mentions from post/comment text.
 *
 * Unicode-aware so that CJK tags like `#摄影` work. Tags are stored lowercased
 * for the slug; original-case display is preserved on first use at tag-upsert
 * time. Mentions resolve to usernames (ASCII per model constraints).
 */
import { MENTION_SOURCE, TAG_SOURCE } from '../contract/limits';

// The patterns are the contract's, shared with the client linkifier — see
// `contract/limits.ts` for the rules (left boundary, 3–24 mention length).
const TAG_RE = new RegExp(TAG_SOURCE, 'gu');
const MENTION_RE = new RegExp(MENTION_SOURCE, 'g');

export function extractTags(text: string): Array<{ slug: string; display: string }> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(TAG_RE)) {
    const display = m[1];
    const slug = display.toLowerCase();
    if (!out.has(slug)) out.set(slug, display);
  }
  return Array.from(out, ([slug, display]) => ({ slug, display }));
}

export function extractMentionUsernames(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) {
    out.add(m[1].toLowerCase());
  }
  return Array.from(out);
}

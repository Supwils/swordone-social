// GENERATED from server/src/contract by contract:sync — do not edit.
/**
 * Plain constants the client uses for display and validation (text limits, id
 * and username patterns, the Era 3 arm ids). No `zod` import on purpose: the
 * client can pull these into any bundle without dragging the schema library
 * along. `common.ts` and `lab/era.ts` re-export them for server code.
 */

/** A primary-key id: ObjectId hex, 24 lowercase hex chars. */
export const ID_RE = /^[a-f0-9]{24}$/;

/** Characters a username may contain. Length is bounded separately (LIMITS). */
export const USERNAME_RE = /^[a-zA-Z0-9_]+$/;

/**
 * @mentions and #tags in post/comment text — ONE definition for the server
 * extractor (`server/src/lib/extract.ts`: what is resolved, tagged and
 * notified) and the client linkifier (`client/src/lib/markdown.tsx`: what
 * renders as a link), so the two cannot disagree.
 *
 * - Mention: `@` + 3–24 of `[A-Za-z0-9_]`, ending at a word boundary (a longer
 *   run is no mention, not a truncated one).
 * - Tag: `#` + a letter/digit/`_` (any script) and up to 63 more of those or `-`.
 * - Left boundary on both: not preceded by an ASCII word character or the same
 *   sigil. ASCII on purpose: `a@bob.com` and `foo#bar` are not links, while
 *   `你好@bob` and `看了#摄影` (CJK text runs straight into the sigil) are.
 *
 * Exported as sources so each side builds its own RegExp (flags below):
 * mention `g`, tag `gu`, combined `gu`. Capture group 1 is the name.
 */
export const MENTION_SOURCE = '(?<![A-Za-z0-9_@])@([A-Za-z0-9_]{3,24})\\b';
export const TAG_SOURCE = '(?<![A-Za-z0-9_#])#([\\p{L}\\p{N}_][\\p{L}\\p{N}_-]{0,63})';

/** Text bounds enforced by the request schemas (zod counts UTF-16 code units). */
export const LIMITS = {
  usernameMin: 3,
  usernameMax: 24,
  postText: 5000,
  commentText: 2000,
  messageText: 4000,
  postSearchQuery: 100,
  userSearch: 32,
  displayNameMax: 80,
  slug: 64,
} as const;

/** The five Era 3 model arms, in pre-registration order. */
export const ARM_IDS = ['openai', 'grok', 'gemini', 'claude-opus', 'claude-haiku'] as const;
export type ArmId = (typeof ARM_IDS)[number];

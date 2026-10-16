/**
 * Shapes and constants shared by every API surface: locales, visibility, error
 * codes, the response envelope, cursor pages, id / username rules and the text
 * limits the request schemas enforce.
 *
 * Contract files import only `zod` and sibling contract files (by file path,
 * never a directory). They are copied verbatim to the client and mcp by
 * `contract:sync`, so nothing here may reach into the rest of the server.
 */
import { z } from 'zod';

// ── Locales ──────────────────────────────────────────────────────────────────

/**
 * The two locales the app ships. Every place that turns a request into a
 * translation target goes through these, so an arbitrary `lang=xx` can never
 * reach the paid Translate API or be persisted as a new `translations` key.
 */
export const LOCALES = ['en', 'zh'] as const;
export type Locale = (typeof LOCALES)[number];
export const localeSchema = z.enum(LOCALES);

// ── Visibility ───────────────────────────────────────────────────────────────

export const VISIBILITIES = ['public', 'followers', 'private'] as const;
export type Visibility = (typeof VISIBILITIES)[number];
export const visibilitySchema = z.enum(VISIBILITIES);

// ── Errors ───────────────────────────────────────────────────────────────────

export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'UNAVAILABLE',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Every error response: `{ error: { code, message, fields?, requestId? } }`.
 * `requestId` is absent when no request id was stamped (it serialises from
 * `undefined`); `fields` maps a dotted input path to its first issue message.
 */
export const ErrorBodySchema = z
  .object({
    error: z
      .object({
        code: z.enum(ERROR_CODES),
        message: z.string(),
        fields: z.record(z.string(), z.string()).optional(),
        requestId: z.string().optional(),
      })
      .strict(),
  })
  .strict();
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

// ── Envelope and pages ───────────────────────────────────────────────────────

/** The success envelope every `ok(res, data)` writes. */
export interface ApiEnvelope<T> {
  data: T;
  meta: { requestId?: string };
}

/** Schema for `{ data, meta }` around a payload schema. */
export function envelope<T extends z.ZodTypeAny>(data: T) {
  return z
    .object({
      data,
      meta: z.object({ requestId: z.string().optional() }).strict(),
    })
    .strict();
}

/** A cursor page: `nextCursor` is null on the last page. */
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

/** Schema for a cursor page of `item`. */
export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z
    .object({
      items: z.array(item),
      nextCursor: z.string().nullable(),
    })
    .strict();
}

// ── Ids, usernames, limits ───────────────────────────────────────────────────

/** A primary-key id: ObjectId hex, 24 lowercase hex chars. */
export const ID_RE = /^[a-f0-9]{24}$/;

/** Characters a username may contain. Length is bounded separately (LIMITS). */
export const USERNAME_RE = /^[a-zA-Z0-9_]+$/;

/** Text bounds enforced by the request schemas (zod counts UTF-16 code units). */
export const LIMITS = {
  usernameMin: 3,
  usernameMax: 24,
  postText: 5000,
  commentText: 2000,
  messageText: 4000,
  postSearchQuery: 100,
  userSearch: 32,
  slug: 64,
} as const;

/** A username as chosen at sign-up or owned-agent creation. */
export const usernameSchema = z
  .string()
  .min(LIMITS.usernameMin)
  .max(LIMITS.usernameMax)
  .regex(USERNAME_RE, 'Letters, numbers, and underscores only');

/**
 * A username naming an existing account (path params, lookups): the same rule
 * as `usernameSchema`, reported with zod's default message.
 */
export const usernameLookupSchema = z
  .string()
  .min(LIMITS.usernameMin)
  .max(LIMITS.usernameMax)
  .regex(USERNAME_RE);

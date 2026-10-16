/**
 * Cursor-based pagination helpers.
 *
 * A cursor is an opaque base64url-encoded JSON `{ t: <ISO timestamp>, id: <string> }`
 * pointing at the last item of the previous page. Queries filter for items strictly
 * older (or newer, depending on sortDir) than the cursor; ties broken by id.
 */
import { and, or, eq, lt, gt, type SQL, type AnyColumn } from 'drizzle-orm';
import { ID_RE } from '../contract/common';

export interface Cursor {
  t: string;
  id: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export function parseLimit(raw: unknown, fallback = DEFAULT_LIMIT): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(MAX_LIMIT, Math.floor(n));
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(raw: unknown): Cursor | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as Partial<Cursor>;
    if (typeof parsed.t !== 'string' || typeof parsed.id !== 'string') return null;
    if (!ID_RE.test(parsed.id)) return null;
    // `new Date(t)` downstream throws on an Invalid Date — a client-controlled 500.
    if (Number.isNaN(Date.parse(parsed.t))) return null;
    return { t: parsed.t, id: parsed.id };
  } catch {
    return null;
  }
}

/**
 * Drizzle WHERE condition for descending keyset pagination by (tsCol, idCol).
 * Returns undefined when there is no cursor (first page).
 */
export function cursorConditionDesc(
  cursor: Cursor | null,
  tsCol: AnyColumn,
  idCol: AnyColumn,
): SQL | undefined {
  if (!cursor) return undefined;
  const t = new Date(cursor.t);
  return or(lt(tsCol, t), and(eq(tsCol, t), lt(idCol, cursor.id)));
}

/** Ascending variant (e.g., comments shown oldest-first). */
export function cursorConditionAsc(
  cursor: Cursor | null,
  tsCol: AnyColumn,
  idCol: AnyColumn,
): SQL | undefined {
  if (!cursor) return undefined;
  const t = new Date(cursor.t);
  return or(gt(tsCol, t), and(eq(tsCol, t), gt(idCol, cursor.id)));
}

/** The keys of `T` whose values are Dates — what a time cursor can be built on. */
type DateKey<T> = { [K in keyof T]: T[K] extends Date ? K : never }[keyof T];

/**
 * Trim a `limit + 1` fetch to one page and encode the cursor at its last row.
 * `key` names the timestamp the query orders by (`createdAt` unless a list sorts
 * by `updatedAt` / `lastMessageAt`), and must match the column the WHERE built
 * by `cursorConditionDesc` / `Asc` compares.
 */
export function buildNextCursor<T extends { id: string }>(
  items: T[],
  limit: number,
  key: DateKey<T> = 'createdAt' as DateKey<T>,
): { items: T[]; nextCursor: string | null } {
  if (items.length <= limit) {
    return { items, nextCursor: null };
  }
  const page = items.slice(0, limit);
  const last = page[page.length - 1];
  const t = last[key] as unknown as Date;
  return {
    items: page,
    nextCursor: encodeCursor({ t: t.toISOString(), id: last.id }),
  };
}

// ── Score-based cursor (for ranked feeds) ────────────────────────────────────

export interface ScoreCursor {
  s: number;
  id: string;
}

export function decodeScoreCursor(raw: unknown): ScoreCursor | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as Partial<ScoreCursor>;
    if (typeof parsed.s !== 'number' || typeof parsed.id !== 'string') return null;
    if (!ID_RE.test(parsed.id)) return null;
    return { s: parsed.s, id: parsed.id };
  } catch {
    return null;
  }
}

/** Drizzle WHERE condition for descending keyset pagination by (scoreCol, idCol). */
export function scoreCursorCondition(
  cursor: ScoreCursor | null,
  scoreCol: AnyColumn,
  idCol: AnyColumn,
): SQL | undefined {
  if (!cursor) return undefined;
  return or(lt(scoreCol, cursor.s), and(eq(scoreCol, cursor.s), lt(idCol, cursor.id)));
}

export function buildNextScoreCursor<T extends { feedScore: number; id: string }>(
  items: T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  if (items.length <= limit) {
    return { items, nextCursor: null };
  }
  const page = items.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: Buffer.from(JSON.stringify({ s: last.feedScore, id: last.id }), 'utf8').toString(
      'base64url',
    ),
  };
}

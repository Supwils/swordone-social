/**
 * Small SQL-building helpers shared across modules.
 */

/** Escape LIKE/ILIKE wildcards (and the escape char) so user input can't inject `%` / `_` patterns. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

import { asc, eq, inArray, isNull, notInArray, or, type SQL } from 'drizzle-orm';
import { db } from '../../db/client';
import { boards, posts } from '../../db/schema';
import { AppError } from '../../lib/errors';

export type BoardRow = typeof boards.$inferSelect;

/** Eval-only boards. Field-study lists and mixed feeds must omit them. */
export const RESERVED_BOARD_SLUGS = ['probes'] as const;

/** All public boards, in display order. Reserved eval boards are omitted. */
export async function listBoards(): Promise<BoardRow[]> {
  return db
    .select()
    .from(boards)
    .where(notInArray(boards.slug, [...RESERVED_BOARD_SLUGS]))
    .orderBy(asc(boards.sortOrder));
}

/**
 * Drop posts filed to a reserved board from mixed feeds. Unfiled posts stay.
 *
 * The reserved ids are a SUBQUERY of the statement it is embedded in, not a
 * lookup of their own: this clause sits on every feed, search and showcase
 * read, and used to cost a separate `boards` query each time. A subquery costs
 * no round trip and, unlike a cached id list, can never go stale (boards are
 * seeded per environment, so their ids are not constants).
 */
export function notReservedBoardClause(): SQL {
  const reserved = db
    .select({ id: boards.id })
    .from(boards)
    .where(inArray(boards.slug, [...RESERVED_BOARD_SLUGS]));
  return or(isNull(posts.boardId), notInArray(posts.boardId, reserved)) as SQL;
}

/** Look a board up by slug. Throws 404 when it does not exist. */
export async function getBoardBySlug(slug: string): Promise<BoardRow> {
  const [row] = await db.select().from(boards).where(eq(boards.slug, slug.toLowerCase())).limit(1);
  if (!row) throw AppError.notFound('Board not found');
  return row;
}

/**
 * Guard for the post-create path. `boardId` arrives from the client, so an
 * unknown id is a client error rather than a missing resource.
 */
export async function assertBoardExists(id: string): Promise<void> {
  const [row] = await db.select({ id: boards.id }).from(boards).where(eq(boards.id, id)).limit(1);
  if (!row) throw AppError.validation('Unknown boardId', { boardId: 'not found' });
}

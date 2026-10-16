/**
 * Shared helpers: day bucketing, agent lookup, lab-population loading.
 *
 * Split out of the former 2018-line agents.service.ts (nine unrelated concerns,
 * six times the 300-line service ceiling). Imported directly since the S2
 * module split; there is no barrel.
 */
import type { LabRange } from '../../../contract/lab/era';
import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../../../db/client';
import { agentEvents, personalitySnapshots, users } from '../../../db/schema';
import { AppError } from '../../../lib/errors';
import type { UserRow } from '../../../lib/dto';
import { eraCondition, type LabEra } from './era';

/* ---------- helpers ---------- */

export function dayBuckets(range: LabRange): { since: Date; days: number } {
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (days - 1));
  return { since, days };
}

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Count rows per UTC day (keyed `YYYY-MM-DD` on the UTC date). */
export function countByDay(dates: Array<{ createdAt: Date }>): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of dates) {
    const k = isoDay(r.createdAt);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/** Split a set of actor rows by AI vs human (null isAgent counts as human). */
export function splitByAgent(rows: Array<{ isAgent: boolean | null }>): {
  ai: number;
  human: number;
} {
  let ai = 0;
  let human = 0;
  for (const r of rows) {
    if (r.isAgent === true) ai += 1;
    else human += 1;
  }
  return { ai, human };
}

/**
 * `/lab` tracks both AI agents (isAgent=true) AND human-simulation accounts
 * that participate in the dream/personality loop — they share the same runtime
 * and have personality.md + memory.md. So we accept any active user here; the
 * /agents list endpoint still surfaces the isAgent flag so the UI can group.
 */
/** Global lab writes (bench scores, population metric) must not be forgeable
 *  by a random registered human or a BYOA account. First-party agents only. */
export function assertFirstPartyLabWrite(actor: UserRow): void {
  if (!actor.isAgent || actor.ownerId) {
    throw AppError.forbidden('Lab writes are limited to first-party agent accounts');
  }
}

export async function findAgentByUsername(username: string): Promise<UserRow> {
  const [u] = await db
    .select()
    .from(users)
    .where(and(eq(users.username, username.toLowerCase()), eq(users.status, 'active')))
    .limit(1);
  if (!u) throw AppError.notFound('Account not found');
  return u;
}

/* ---------- lab population loader (shared by graph / pulse / alerts) ---------- */

/** A lab participant: an AI agent, or a human account inside the dream loop. */
export interface LabUser {
  id: string;
  username: string;
  displayName: string;
  isAgent: boolean;
  archivedAt: Date | null;
}

const labUserColumns = {
  id: users.id,
  username: users.username,
  displayName: users.displayName,
  isAgent: users.isAgent,
  archivedAt: users.archivedAt,
};

/**
 * The population a lab read covers. With an era, exactly that era's accounts
 * (`eraCondition`). Without one — per-account reads such as influences, which
 * take no era — every agent plus any account that ever entered the dream/event
 * loop, across both eras.
 */
export async function loadLabUsers(era?: LabEra): Promise<LabUser[]> {
  if (era !== undefined) {
    return db
      .select(labUserColumns)
      .from(users)
      .where(and(eq(users.status, 'active'), eraCondition(era)));
  }
  const [snapUserRows, eventUserRows] = await Promise.all([
    db.selectDistinct({ userId: personalitySnapshots.userId }).from(personalitySnapshots),
    db.selectDistinct({ userId: agentEvents.userId }).from(agentEvents),
  ]);
  const labUserIds = Array.from(
    new Set([...snapUserRows.map((r) => r.userId), ...eventUserRows.map((r) => r.userId)]),
  );
  const orCond = labUserIds.length
    ? or(eq(users.isAgent, true), inArray(users.id, labUserIds))
    : eq(users.isAgent, true);
  return db
    .select(labUserColumns)
    .from(users)
    .where(and(eq(users.status, 'active'), orCond));
}

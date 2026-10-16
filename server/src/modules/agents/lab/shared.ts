/**
 * Shared helpers: day keys, account lookup, public-only filters, lab-population loading.
 * The time window a read covers lives in `./window`.
 *
 * Split out of the former 2018-line agents.service.ts (nine unrelated concerns,
 * six times the 300-line service ceiling). Imported directly since the S2
 * module split; there is no barrel.
 */
import { and, eq, exists, inArray, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { db } from '../../../db/client';
import {
  agentEvents,
  comments,
  likes,
  personalitySnapshots,
  posts,
  users,
} from '../../../db/schema';
import { AppError } from '../../../lib/errors';
import type { UserRow } from '../../../lib/dto';
import { eraCondition, type LabEra } from './era';

/* ---------- helpers ---------- */

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

/** Global lab writes (bench scores, population metric) must not be forgeable
 *  by a random registered human or a BYOA account. First-party agents only. */
export function assertFirstPartyLabWrite(actor: UserRow): void {
  if (!actor.isAgent || actor.ownerId) {
    throw AppError.forbidden('Lab writes are limited to first-party agent accounts');
  }
}

/**
 * Account lookup for lab INGEST. Accepts any active user: Era 2's simulated
 * humans (`isAgent: false`) shared the agents' runtime and uploaded snapshots
 * and events like them. Every ingest service follows this with its own
 * self-check (`agent.id !== actor.id` → 403), which is the real gate.
 * Per-account READS use `findLabAccount` instead.
 */
export async function findAgentByUsername(username: string): Promise<UserRow> {
  const [u] = await db
    .select()
    .from(users)
    .where(and(eq(users.username, username.toLowerCase()), eq(users.status, 'active')))
    .limit(1);
  if (!u) throw AppError.notFound('Account not found');
  return u;
}

/**
 * Account lookup for public per-account lab READS (`/:username/stats`,
 * `/collapse`, `/influences`, `/rounds`, `/drift`, …). Those reads are open to
 * anyone, so they answer only for an account that is openly in the experiment:
 * an agent, or a sealed Era 2 participant (`archived_at` set — that includes
 * Era 2's simulated humans). An ordinary human 404s exactly like an unknown
 * name, so the lab cannot be used to profile one — it used to serve any active
 * account's posting cadence, likers and private-post lengths.
 */
export async function findLabAccount(username: string): Promise<UserRow> {
  const [u] = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.username, username.toLowerCase()),
        eq(users.status, 'active'),
        or(eq(users.isAgent, true), isNotNull(users.archivedAt)),
      ),
    )
    .limit(1);
  if (!u) throw AppError.notFound('Account not found');
  return u;
}

/* ---------- public-only filters for per-account reads ---------- */

// Aliased so a correlated subquery never collides with an outer `posts` /
// `comments` in the query it is embedded in.
const visPosts = alias(posts, 'lab_vis_posts');
const visComments = alias(comments, 'lab_vis_comments');

/**
 * The post `postId` points at is public and live. Per-account lab reads are
 * public, so they count only what any visitor could already see on the
 * platform; a followers-only or private post, a deleted or hidden one (or a
 * comment under one) is not lab data.
 */
export function onPublicPost(postId: AnyPgColumn): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(visPosts)
      .where(
        and(
          eq(visPosts.id, postId),
          eq(visPosts.visibility, 'public'),
          eq(visPosts.status, 'active'),
        ),
      ),
  );
}

/** A like whose target — a post, or a live comment's post — is public and live. */
export function likeOnPublicTarget(): SQL {
  return or(
    and(eq(likes.targetType, 'post'), onPublicPost(likes.targetId)),
    and(
      eq(likes.targetType, 'comment'),
      exists(
        db
          .select({ one: sql`1` })
          .from(visComments)
          .innerJoin(visPosts, eq(visComments.postId, visPosts.id))
          .where(
            and(
              eq(visComments.id, likes.targetId),
              eq(visComments.status, 'active'),
              eq(visPosts.visibility, 'public'),
              eq(visPosts.status, 'active'),
            ),
          ),
      ),
    ),
  ) as SQL;
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

/** One era's lab population (`eraCondition`), active accounts only. */
export async function loadLabUsers(era: LabEra): Promise<LabUser[]> {
  return db
    .select(labUserColumns)
    .from(users)
    .where(and(eq(users.status, 'active'), eraCondition(era)));
}

/**
 * The given ids that are lab participants, across both eras: an active agent,
 * or an active account that ever entered the dream/event loop (it has a
 * personality snapshot or a lab event). For per-account reads such as
 * influences, which take no era — it looks up only the ids in hand rather than
 * loading the whole population.
 */
export async function loadLabUsersByIds(ids: readonly string[]): Promise<LabUser[]> {
  if (ids.length === 0) return [];
  return db
    .select(labUserColumns)
    .from(users)
    .where(
      and(
        inArray(users.id, [...ids]),
        eq(users.status, 'active'),
        or(
          eq(users.isAgent, true),
          exists(
            db
              .select({ one: sql`1` })
              .from(personalitySnapshots)
              .where(eq(personalitySnapshots.userId, users.id)),
          ),
          exists(
            db
              .select({ one: sql`1` })
              .from(agentEvents)
              .where(eq(agentEvents.userId, users.id)),
          ),
        ),
      ),
    );
}

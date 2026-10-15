import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { users } from '../../db/schema';
import type { UserPreferences } from '../../contract/users';
import { AppError } from '../../lib/errors';
import { uploadBufferToS3, deleteFromS3 } from '../../config/s3';
import type { UserRow } from '../../lib/dto';
import type { UpdateMeInput } from './users.schemas';

/** Escape LIKE/ILIKE wildcards so user input can't inject `%` / `_` patterns. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

export async function findByUsername(username: string): Promise<UserRow> {
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.username, username.toLowerCase()), eq(users.status, 'active')))
    .limit(1);
  if (!user) throw AppError.notFound('User not found');
  return user;
}

/**
 * Best-effort lookup for enrichment (e.g. an agent profile's owner). Returns
 * null instead of throwing so a vanished/suspended owner never breaks the
 * page that references them.
 */
export async function findById(id: string): Promise<UserRow | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, id), eq(users.status, 'active')))
    .limit(1);
  return user ?? null;
}

export async function updateMe(user: UserRow, patch: UpdateMeInput): Promise<UserRow> {
  const set: Partial<typeof users.$inferInsert> = {};
  if (patch.displayName !== undefined) set.displayName = patch.displayName;
  if (patch.bio !== undefined) set.bio = patch.bio;
  if (patch.headline !== undefined) set.headline = patch.headline;
  if (patch.location !== undefined) set.location = patch.location;
  if (patch.website !== undefined) set.website = patch.website;
  if (patch.birthdate !== undefined) set.birthdate = patch.birthdate as Date | null;
  if (patch.preferences) {
    set.preferences = {
      ...(user.preferences ?? {}),
      ...patch.preferences,
    } as UserPreferences;
  }
  if (patch.profileTags !== undefined) {
    set.profileTags = patch.profileTags.map((t) => t.trim().toLowerCase()).filter(Boolean);
  }
  // Any account may record its backend, agent-flagged or not. Era 2's `humans/`
  // cohort (archived 2026-10-14) was LLM-driven too — the model tier was the
  // drift experiment's independent variable — but ran with `isAgent: false` on
  // purpose, so the old `isAgent` guard 403'd their sync every round. The Bash
  // act loop swallowed it with `|| true`, leaving two accounts
  // null and six holding pre-guard values with no model tier. `isAgent` remains
  // the field that says what an account *is*; `agentBackend` only records what
  // drives it.
  if (patch.agentBackend !== undefined) {
    set.agentBackend = patch.agentBackend;
  }
  set.updatedAt = new Date();

  const [updated] = await db.update(users).set(set).where(eq(users.id, user.id)).returning();
  return updated;
}

export async function updateAvatar(user: UserRow, buffer: Buffer): Promise<UserRow> {
  const oldUrl = user.avatarUrl;
  const { url } = await uploadBufferToS3(buffer, 'avatars');
  const [updated] = await db
    .update(users)
    .set({ avatarUrl: url, updatedAt: new Date() })
    .where(eq(users.id, user.id))
    .returning();
  // Delete old avatar after save succeeds
  if (oldUrl) void deleteFromS3(oldUrl);
  return updated;
}

/**
 * Search users by username/displayName prefix and/or profile tag.
 * If neither query nor tag is provided, returns top users by followerCount.
 * Without a query (the Explore People browse), archived accounts are left out;
 * a name search still finds them.
 */
export async function searchUsers(
  query: string | undefined,
  tag: string | undefined,
  limit: number,
): Promise<UserRow[]> {
  const where = and(
    eq(users.status, 'active'),
    query
      ? or(
          ilike(users.username, `${escapeLike(query.toLowerCase())}%`),
          ilike(users.displayName, `${escapeLike(query)}%`),
        )
      : isNull(users.archivedAt),
    // profileTags are stored lowercased, so an array-contains membership test is
    // equivalent to the old case-insensitive `^tag$` regex over each element.
    tag ? sql`${users.profileTags} @> ARRAY[${tag.toLowerCase()}]::text[]` : undefined,
  );

  return db
    .select()
    .from(users)
    .where(where)
    .orderBy(desc(users.followerCount))
    .limit(Math.min(50, Math.max(1, limit)));
}

export async function getPopularProfileTags(): Promise<Array<{ tag: string; count: number }>> {
  const result = await db.execute<{ tag: string; count: number }>(sql`
    SELECT tag, COUNT(*)::int AS count
    FROM ${users}, unnest(${users.profileTags}) AS tag
    WHERE ${users.status} = 'active'
    GROUP BY tag
    ORDER BY count DESC
    LIMIT 50
  `);
  return result.rows.map((r) => ({ tag: r.tag, count: Number(r.count) }));
}

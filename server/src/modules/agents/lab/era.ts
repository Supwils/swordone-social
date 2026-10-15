/**
 * Era scoping for lab reads (S2 §6). One condition on `users` decides which
 * population a read covers, so every caller agrees on what "Era 3" means.
 */
import { and, eq, isNotNull, isNull, type SQL } from 'drizzle-orm';
import { users } from '../../../db/schema';

export type LabEra = 2 | 3;

/**
 * Era 3 = non-archived first-party agents (`is_agent`, no owner). Era 2 = every
 * archived account, agent or simulated human (Era 1 is the same accounts'
 * earlier history). Callers add `status = 'active'` where they already did.
 */
export function eraCondition(era: LabEra): SQL {
  if (era === 2) return isNotNull(users.archivedAt);
  return and(eq(users.isAgent, true), isNull(users.ownerId), isNull(users.archivedAt)) as SQL;
}

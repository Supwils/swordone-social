/**
 * The time window every lab read covers (S6, ruling 7).
 *
 * ONE SEMANTICS: a range is `RANGE_DAYS[range]` UTC calendar days, the last of
 * them being the day the window ends on, from that first day's midnight to the
 * end instant. Day-bucketed charts get exactly `days` buckets, and a fit, a
 * count and a chart over the same range now cover the same span (they used to
 * disagree: rolling `now − N×24h` in some reads, calendar days in others).
 *
 * ONE END: Era 3 windows end now. Era 2 is sealed, so its windows end at the
 * seal — the newest `archived_at` — or a sealed dashboard would slide off its
 * own data and read empty about 90 days after the seal. Per-account reads end
 * at that account's own `archived_at`, or now.
 *
 * No `<= until` filter is needed for an Era 2 window: a sealed account cannot
 * write after its seal (every social write is 403), so no Era 2 row post-dates
 * it.
 */
import { isNotNull, max } from 'drizzle-orm';
import { RANGE_DAYS, type LabRange } from '../../../contract/lab/era';
import { db } from '../../../db/client';
import { users } from '../../../db/schema';
import { TTLCache } from '../../../lib/ttlCache';
import { isoDay } from './shared';
import type { LabEra } from './era';

export interface LabWindow {
  /** Midnight UTC of the window's first day. */
  since: Date;
  /** The instant the window ends: now, or a seal. */
  until: Date;
  /** Calendar days covered, `RANGE_DAYS[range]`. */
  days: number;
}

/** Pure: the `range`'s calendar-day window ending at `until`. */
export function calendarWindow(range: LabRange, until: Date): LabWindow {
  const days = RANGE_DAYS[range];
  const since = new Date(until.getTime());
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (days - 1));
  return { since, until, days };
}

/** The window's `YYYY-MM-DD` UTC day keys, oldest first — `days` of them. */
export function windowDayKeys(w: LabWindow): string[] {
  const keys: string[] = [];
  for (let i = 0; i < w.days; i += 1) {
    const d = new Date(w.since.getTime());
    d.setUTCDate(w.since.getUTCDate() + i);
    keys.push(isoDay(d));
  }
  return keys;
}

// The seal moves only when accounts are archived (an operator action), so a
// minute of staleness is harmless and saves a query per cache miss upstream.
const sealCache = new TTLCache<'seal', Date | null>(60_000);

/** Test hook — a suite that seeds a different seal per test clears this. */
export function clearEraSealCache(): void {
  sealCache.clear();
}

/**
 * The Era 2 seal: the newest `archived_at`, or null before anything was sealed.
 * This is `max(archived_at)` over ALL archived accounts, so if Era 3 is ever
 * sealed too, it must be scoped to the Era 2 boundary or Era 2 windows move.
 */
export async function eraSeal(): Promise<Date | null> {
  return sealCache.getOrLoad('seal', async () => {
    const [row] = await db
      .select({ at: max(users.archivedAt) })
      .from(users)
      .where(isNotNull(users.archivedAt));
    return row?.at ?? null;
  });
}

/** A population read's window: Era 3 ends now, Era 2 at the seal. */
export async function labWindow(
  range: LabRange,
  era: LabEra,
  now: Date = new Date(),
): Promise<LabWindow> {
  const end = era === 2 ? ((await eraSeal()) ?? now) : now;
  return calendarWindow(range, end);
}

/** A per-account read's window: ends at the account's seal, or now. */
export function accountWindow(
  range: LabRange,
  account: { archivedAt: Date | null },
  now: Date = new Date(),
): LabWindow {
  return calendarWindow(range, account.archivedAt ?? now);
}

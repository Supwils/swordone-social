/**
 * Rounds and the confirmatory window (amendment 1, "Instruments").
 *
 * A round is the set of roster `cycle_run` cards sharing `metrics.roundId`.
 * Everything that decides which data the metrics may use — completion, the
 * window, sweep ordinals, arm rounds, model-mismatch deviations — is computed
 * here once, by the pure `buildRounds`, and handed to the metrics.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../../db/client';
import { agentEvents, users } from '../../../db/schema';
import { ARMS, armOf, type ArmId } from '../lab/roster';
import { ROUND_ID_RE } from './arms.schemas';
import type { RoundDTO } from '../../../contract/lab/arms';
import { COMPLETED_MIN_CARDS, TARGET_ROUNDS } from './protocol';

export type RoundKind = 'sweep' | 'manual';

/** A registered, active roster account. */
export interface RosterUser {
  id: string;
  username: string;
  arm: ArmId;
}

/** A `cycle_run` card as stored. */
export interface RawCard {
  id: string;
  userId: string;
  createdAt: Date;
  outcome: string;
  metrics: Record<string, unknown>;
}

export interface RoundCard extends RawCard {
  roundId: string;
  kind: RoundKind;
}

export interface WindowRound {
  roundId: string;
  /** 1-based index among the window's sweep rounds. */
  ordinal: number;
  completed: boolean;
}

export interface RoundsState {
  roster: RosterUser[];
  /** Deduplicated roster cards (first per account and round). */
  cards: RoundCard[];
  /** Every round seen on a roster card, oldest first. */
  rounds: RoundDTO[];
  /** Sweep rounds of the confirmatory window, oldest first. */
  window: WindowRound[];
  /** The 12th completed round once it exists: the verdict is frozen on the window. */
  frozenAt: string | null;
  completedRounds: number;
  armRounds: Record<ArmId, number>;
  /** `cardKey(userId, roundId)` of every model-mismatch cycle — excluded from (a)–(c). */
  mismatches: ReadonlySet<string>;
}

const MODEL_BY_ARM: ReadonlyMap<ArmId, string> = new Map(ARMS.map((a) => [a.id, a.model]));

export function zeroByArm(): Record<ArmId, number> {
  return Object.fromEntries(ARMS.map((a) => [a.id, 0])) as Record<ArmId, number>;
}

export function cardKey(userId: string, roundId: string): string {
  return `${userId}|${roundId}`;
}

/**
 * `kind` from the suffix and `startedAt` from the timestamp (§7: never from a
 * card's `created_at`). Null for anything that is not a real UTC instant in
 * the §3 format.
 */
export function parseRoundId(id: string): { kind: RoundKind; startedAt: string } | null {
  if (!ROUND_ID_RE.test(id)) return null;
  const [y, mo, d, h, mi, s] = [
    id.slice(0, 4),
    id.slice(4, 6),
    id.slice(6, 8),
    id.slice(9, 11),
    id.slice(11, 13),
    id.slice(13, 15),
  ].map(Number);
  const at = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  // Date.UTC rolls 30 February over to March: a round trip catches it.
  if (
    at.getUTCFullYear() !== y ||
    at.getUTCMonth() !== mo - 1 ||
    at.getUTCDate() !== d ||
    at.getUTCHours() !== h ||
    at.getUTCMinutes() !== mi ||
    at.getUTCSeconds() !== s
  ) {
    return null;
  }
  return { kind: id.endsWith('-r') ? 'sweep' : 'manual', startedAt: at.toISOString() };
}

/**
 * Cards with a valid round id, the earliest per (account, round): a second
 * card for the same account and round is ignored (amendment, "Completed round").
 */
export function dedupeCards(cards: readonly RawCard[]): RoundCard[] {
  const sorted = [...cards].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
  const seen = new Set<string>();
  const out: RoundCard[] = [];
  for (const c of sorted) {
    const roundId = c.metrics.roundId;
    if (typeof roundId !== 'string') continue;
    const parsed = parseRoundId(roundId);
    if (!parsed) continue;
    const key = cardKey(c.userId, roundId);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...c, roundId, kind: parsed.kind });
  }
  return out;
}

/** The resolved `<backend>:<model>` the card says the cycle used, or null. */
export function modelLabel(metrics: Record<string, unknown>): string | null {
  const { backend, model } = metrics;
  return typeof backend === 'string' && typeof model === 'string' ? `${backend}:${model}` : null;
}

/** Pure core of `loadRoundsState`. Cards of non-roster accounts are ignored. */
export function buildRounds(
  rawCards: readonly RawCard[],
  roster: readonly RosterUser[],
): RoundsState {
  const armByUser = new Map(roster.map((u) => [u.id, u.arm]));
  const cards = dedupeCards(rawCards.filter((c) => armByUser.has(c.userId)));

  // A card without a label cannot show it ran the arm's model: a deviation too.
  const mismatches = new Set<string>();
  for (const c of cards) {
    const arm = armByUser.get(c.userId) as ArmId;
    if (modelLabel(c.metrics) !== MODEL_BY_ARM.get(arm)) {
      mismatches.add(cardKey(c.userId, c.roundId));
    }
  }

  const byRound = new Map<string, RoundCard[]>();
  for (const c of cards) {
    const list = byRound.get(c.roundId) ?? [];
    list.push(c);
    byRound.set(c.roundId, list);
  }
  // The timestamp leads the id, so lexicographic order is time order.
  const ids = [...byRound.keys()].sort();

  const rounds: RoundDTO[] = [];
  const window: WindowRound[] = [];
  let completedRounds = 0;
  let frozenAt: string | null = null;
  for (const roundId of ids) {
    const parsed = parseRoundId(roundId) as { kind: RoundKind; startedAt: string };
    const n = (byRound.get(roundId) as RoundCard[]).length;
    const completed = parsed.kind === 'sweep' && n >= COMPLETED_MIN_CARDS;
    if (completed) completedRounds += 1;
    const inWindow = parsed.kind === 'sweep' && frozenAt === null;
    const ordinal = inWindow ? window.length + 1 : null;
    if (inWindow) window.push({ roundId, ordinal: ordinal as number, completed });
    if (inWindow && completed && completedRounds === TARGET_ROUNDS) frozenAt = roundId;
    rounds.push({
      roundId,
      kind: parsed.kind,
      startedAt: parsed.startedAt,
      cards: n,
      completed,
      ordinal,
      inWindow,
    });
  }

  // Arm data in a round: ≥ 1 non-fail card from the arm in a completed window
  // round. A model-mismatch card is excluded from (a)–(c), so it is no arm data.
  const armRounds = zeroByArm();
  for (const w of window) {
    if (!w.completed) continue;
    const arms = new Set<ArmId>();
    for (const c of byRound.get(w.roundId) as RoundCard[]) {
      if (c.outcome === 'fail' || mismatches.has(cardKey(c.userId, c.roundId))) continue;
      arms.add(armByUser.get(c.userId) as ArmId);
    }
    for (const arm of arms) armRounds[arm] += 1;
  }

  return {
    roster: [...roster],
    cards,
    rounds,
    window,
    frozenAt,
    completedRounds,
    armRounds,
    mismatches,
  };
}

/**
 * Roster usernames resolved among ALL users, whatever their status: a roster
 * account suspended or deleted later must not move the window or the verdict.
 * Unregistered accounts are absent.
 */
export async function loadRosterUsers(): Promise<RosterUser[]> {
  const usernames = ARMS.flatMap((a) => a.usernames);
  const rows = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(inArray(users.username, usernames));
  return rows.map((r) => ({ ...r, arm: armOf(r.username) as ArmId }));
}

/** Every `cycle_run` card that carries a round id, for the given accounts. */
export async function loadCycleRunCards(userIds: readonly string[]): Promise<RawCard[]> {
  if (userIds.length === 0) return [];
  return db
    .select({
      id: agentEvents.id,
      userId: agentEvents.userId,
      createdAt: agentEvents.createdAt,
      outcome: agentEvents.outcome,
      metrics: agentEvents.metrics,
    })
    .from(agentEvents)
    .where(
      and(
        inArray(agentEvents.userId, [...userIds]),
        eq(agentEvents.type, 'cycle'),
        sql`${agentEvents.metrics}->>'kind' = 'cycle_run'`,
        sql`${agentEvents.metrics}->>'roundId' IS NOT NULL`,
      ),
    )
    .orderBy(asc(agentEvents.createdAt), asc(agentEvents.id));
}

export async function loadRoundsState(): Promise<RoundsState> {
  const roster = await loadRosterUsers();
  const cards = await loadCycleRunCards(roster.map((u) => u.id));
  return buildRounds(cards, roster);
}

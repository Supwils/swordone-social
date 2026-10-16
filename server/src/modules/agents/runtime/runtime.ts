/**
 * Runtime-health aggregate over cycle_run cards.
 *
 * Lives in its own file because population/pulse.ts is already well over the
 * 300-line service-file ceiling.
 */
import type { LabRange } from '../../../contract/lab/era';
import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '../../../db/client';
import { agentEvents, users } from '../../../db/schema';
import { TTLCache } from '../../../lib/ttlCache';
import { finiteOr } from '../../../lib/numeric';
import { isoDay } from '../lab/shared';
import { labWindow, windowDayKeys } from '../lab/window';
import type { RuntimeHealthDTO, RuntimeHealthPointDTO } from '../../../contract/lab/runtime';
import { eraCondition, type LabEra } from '../lab/era';

const runtimeCache = new TTLCache<string, RuntimeHealthDTO>(60_000);

/** Test hook — the 60s TTL would otherwise pin the first range of a suite. */
export function clearRuntimeHealthCache(): void {
  runtimeCache.clear();
}

export async function getRuntimeHealth(
  range: LabRange = '30d',
  era: LabEra = 3,
): Promise<RuntimeHealthDTO> {
  return runtimeCache.getOrLoad(`${range}:${era}`, () => computeRuntimeHealth(range, era));
}

function isTrue(value: unknown): boolean {
  return value === true;
}

async function computeRuntimeHealth(range: LabRange, era: LabEra): Promise<RuntimeHealthDTO> {
  const window = await labWindow(range, era);
  const { since } = window;

  const byDay = new Map<string, RuntimeHealthPointDTO>();
  for (const key of windowDayKeys(window)) {
    byDay.set(key, {
      date: key,
      rounds: 0,
      failOpen: 0,
      missingSamples: 0,
      landed: 0,
      missingPostVectors: 0,
    });
  }

  const rows = await db
    .select({
      userId: agentEvents.userId,
      createdAt: agentEvents.createdAt,
      metrics: agentEvents.metrics,
    })
    .from(agentEvents)
    // The card's author decides its era (S2 §6).
    .innerJoin(users, eq(users.id, agentEvents.userId))
    .where(
      and(
        eq(users.status, 'active'),
        eraCondition(era),
        eq(agentEvents.type, 'cycle'),
        eq(sql<string>`${agentEvents.metrics}->>'kind'`, 'cycle_run'),
        gte(agentEvents.createdAt, since),
      ),
    );

  const accounts = new Set<string>();
  let failOpenGates = 0;
  let missingSamples = 0;
  let landedActions = 0;
  let missingPostVectors = 0;

  for (const r of rows) {
    accounts.add(r.userId);
    const metrics = r.metrics ?? {};
    // `gateStatus` and `missingRuleCheck` are Era 2 fields: Era 3 cards omit
    // both (no drift gate, no rule check). Absent reads as "not fail-open" and
    // "not missing", so older rows still count and newer ones are not penalised.
    const failOpen = metrics.gateStatus === 'fail_open';
    const missing = isTrue(metrics.missingBehaviorSnapshot) || isTrue(metrics.missingRuleCheck);
    const landed = finiteOr(metrics.landed, 0);
    // Era 3 act path: a post landed but its vector did not (embedder down).
    const missingVector = isTrue(metrics.missingPostVector);
    if (failOpen) failOpenGates += 1;
    if (missingVector) missingPostVectors += 1;
    if (missing) missingSamples += 1;
    landedActions += landed;

    const point = byDay.get(isoDay(r.createdAt));
    if (!point) continue;
    point.rounds += 1;
    if (failOpen) point.failOpen += 1;
    if (missing) point.missingSamples += 1;
    point.landed += landed;
    if (missingVector) point.missingPostVectors += 1;
  }

  return {
    range,
    rounds: rows.length,
    accountsRun: accounts.size,
    failOpenGates,
    missingSamples,
    landedActions,
    missingPostVectors,
    points: Array.from(byDay.values()),
  };
}

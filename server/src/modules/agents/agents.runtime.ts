/**
 * Runtime-health aggregate over cycle_run cards.
 *
 * Lives in its own file because agents.pulse.ts is already well over the
 * 300-line service-file ceiling. The controller still imports through the
 * agents.service.ts barrel, same as pulse / alerts / influences.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { agentEvents } from '../../db/schema';
import { TTLCache } from '../../lib/ttlCache';
import { dayBuckets, isoDay } from './agents.shared';
import type { RuntimeHealthDTO, RuntimeHealthPointDTO } from './agents.types';

const runtimeCache = new TTLCache<string, RuntimeHealthDTO>(60_000);

/** Test hook — the 60s TTL would otherwise pin the first range of a suite. */
export function clearRuntimeHealthCache(): void {
  runtimeCache.clear();
}

export async function getRuntimeHealth(
  range: '7d' | '30d' | '90d' = '30d',
): Promise<RuntimeHealthDTO> {
  return runtimeCache.getOrLoad(range, () => computeRuntimeHealth(range));
}

function isTrue(value: unknown): boolean {
  return value === true;
}

function asFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

async function computeRuntimeHealth(range: '7d' | '30d' | '90d'): Promise<RuntimeHealthDTO> {
  const { since } = dayBuckets(range);

  const byDay = new Map<string, RuntimeHealthPointDTO>();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let d = new Date(since); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = isoDay(d);
    byDay.set(key, { date: key, rounds: 0, failOpen: 0, missingSamples: 0, landed: 0 });
  }

  const rows = await db
    .select({
      userId: agentEvents.userId,
      createdAt: agentEvents.createdAt,
      metrics: agentEvents.metrics,
    })
    .from(agentEvents)
    .where(
      and(
        eq(agentEvents.type, 'cycle'),
        eq(sql<string>`${agentEvents.metrics}->>'kind'`, 'cycle_run'),
        gte(agentEvents.createdAt, since),
      ),
    );

  const accounts = new Set<string>();
  let failOpenGates = 0;
  let missingSamples = 0;
  let landedActions = 0;

  for (const r of rows) {
    accounts.add(r.userId);
    const metrics = r.metrics ?? {};
    // `gateStatus` and `missingRuleCheck` are Era 2 fields: Era 3 cards omit
    // both (no drift gate, no rule check). Absent reads as "not fail-open" and
    // "not missing", so older rows still count and newer ones are not penalised.
    const failOpen = metrics.gateStatus === 'fail_open';
    const missing = isTrue(metrics.missingBehaviorSnapshot) || isTrue(metrics.missingRuleCheck);
    const landed = asFiniteNumber(metrics.landed);
    if (failOpen) failOpenGates += 1;
    if (missing) missingSamples += 1;
    landedActions += landed;

    const point = byDay.get(isoDay(r.createdAt));
    if (!point) continue;
    point.rounds += 1;
    if (failOpen) point.failOpen += 1;
    if (missing) point.missingSamples += 1;
    point.landed += landed;
  }

  return {
    range,
    rounds: rows.length,
    accountsRun: accounts.size,
    failOpenGates,
    missingSamples,
    landedActions,
    points: Array.from(byDay.values()),
  };
}

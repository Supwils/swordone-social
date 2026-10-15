import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../../db/client';
import { resetDb } from '../../../test/db-reset';
import { agentEvents } from '../../../db/schema';
import { seedUser } from '../lab/lab.testSeeds';
import { getAgentEvents, ingestAgentEvent, toAgentEventDTO } from './events';
import { AgentEventDTOSchema } from '../../../contract/lab/runtime';
import { expectContract } from '../../../test/contract';

beforeEach(resetDb);

describe('runtime events', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects event ingest when the actor is not the agent itself', async () => {
    await seedUser({ username: 'zenith', isAgent: true });
    const other = await seedUser({ username: 'someoneelse', isAgent: true });

    await expect(
      ingestAgentEvent('zenith', other, {
        type: 'cycle',
        phase: 'act',
        outcome: 'success',
        action: 'nothing',
        summary: 'chose to do nothing',
        metrics: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('stores and returns structured lab events', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });

    const out = await ingestAgentEvent('zenith', agent, {
      type: 'cycle',
      phase: 'act',
      outcome: 'success',
      action: 'post',
      summary: 'posted a note',
      metrics: {},
    });

    expect(out).toMatchObject({
      type: 'cycle',
      phase: 'act',
      outcome: 'success',
      action: 'post',
      summary: 'posted a note',
    });

    // The row is persisted against the agent's own id.
    const [row] = await db.select().from(agentEvents).where(eq(agentEvents.id, out.id));
    expect(row.userId).toBe(agent.id);
  });

  it('records an anomaly event at the moment it occurred, not the moment it was ingested', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });
    // Weeks in the past, so `createdAt === occurredAt` is distinguishable from
    // every value `defaultNow()` could have produced (standing constraint §4).
    const occurredAt = new Date('2026-08-05T08:35:04.000Z');
    const before = Date.now();

    const out = await ingestAgentEvent('zenith', agent, {
      type: 'anomaly',
      phase: 'anomaly',
      outcome: 'flagged',
      summary: '人工干预：短语固着回滚',
      metrics: { intervention: 'personality_rollback', gateBypassed: true },
      occurredAt,
    });

    expect(out.createdAt).toBe(occurredAt.toISOString());

    const [row] = await db.select().from(agentEvents).where(eq(agentEvents.id, out.id));
    expect(row.createdAt.toISOString()).toBe(occurredAt.toISOString());
    // `updatedAt` records when the ROW was written and is deliberately NOT
    // backdated — so this also proves the override is scoped to `createdAt`.
    expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('leaves createdAt at ingest time when no occurredAt is given', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });
    const before = Date.now() - 1000;

    const out = await ingestAgentEvent('zenith', agent, {
      type: 'cycle',
      phase: 'act',
      outcome: 'success',
      summary: 'posted a note',
      metrics: {},
    });

    const [row] = await db.select().from(agentEvents).where(eq(agentEvents.id, out.id));
    expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('sorts a backfilled event by when it occurred, not by when it was stored', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });
    // Stored SECOND but dated FIRST: the read orders by created_at desc, so a
    // backfill that ignored `occurredAt` would put the old intervention at the
    // top of the timeline instead of back where it belongs.
    await ingestAgentEvent('zenith', agent, {
      type: 'cycle',
      phase: 'act',
      outcome: 'success',
      summary: 'recent round',
      metrics: {},
    });
    await ingestAgentEvent('zenith', agent, {
      type: 'anomaly',
      phase: 'anomaly',
      outcome: 'flagged',
      summary: 'old intervention',
      metrics: {},
      occurredAt: new Date('2026-08-05T08:35:04.000Z'),
    });

    const items = await getAgentEvents('zenith', 20);
    expect(items.map((e) => e.summary)).toEqual(['recent round', 'old intervention']);
  });

  it('accepts a rule_check event (Feature 4 enum)', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });

    const out = await ingestAgentEvent('zenith', agent, {
      type: 'rule_check',
      phase: 'rule',
      outcome: 'flagged',
      summary: 'hashtag count 2-4: 7/12 posts adherent (58%)',
      metrics: { rule: 'hashtag_count', passRate: 0.58, checked: 12 },
    });

    expect(out).toMatchObject({ type: 'rule_check', phase: 'rule', outcome: 'flagged' });
    expect(out.metrics).toMatchObject({ rule: 'hashtag_count', passRate: 0.58 });
  });

  it('lists recent events for a focused agent, filtered by type', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });
    await db.insert(agentEvents).values([
      {
        userId: agent.id,
        type: 'memory',
        phase: 'memory',
        outcome: 'success',
        summary: 'memory synced',
      },
      {
        userId: agent.id,
        type: 'cycle',
        phase: 'act',
        outcome: 'success',
        summary: 'acted',
      },
    ]);

    const out = await getAgentEvents('zenith', 5, 'memory');

    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('memory');
  });
});

describe('toAgentEventDTO (contract)', () => {
  // A row with EVERY column, so a mapper that spread the row would leak
  // `userId` / `updatedAt` and fail the strict schema by name.
  const row = {
    id: 'e'.repeat(24),
    userId: 'u'.repeat(24),
    type: 'cycle' as const,
    phase: 'act' as const,
    outcome: 'success' as const,
    action: 'comment' as const,
    summary: '→@xiaoyu',
    reason: 'replied',
    targetId: 'p'.repeat(24),
    metrics: { roundId: '20261014T060000Z-r', maxSim: 0.3 },
    createdAt: new Date('2026-10-14T06:00:00.000Z'),
    updatedAt: new Date('2026-10-14T06:00:01.000Z'),
  };

  it('maps a full row to the strict contract shape', () => {
    const dto = expectContract(AgentEventDTOSchema, toAgentEventDTO(row));
    expect(dto).toEqual({
      id: row.id,
      type: 'cycle',
      phase: 'act',
      outcome: 'success',
      action: 'comment',
      summary: '→@xiaoyu',
      reason: 'replied',
      targetId: row.targetId,
      metrics: row.metrics,
      createdAt: '2026-10-14T06:00:00.000Z',
    });
  });

  it('omits null action / reason / targetId instead of sending null', () => {
    const dto = expectContract(
      AgentEventDTOSchema,
      toAgentEventDTO({ ...row, action: null, reason: null, targetId: null }),
    );
    expect(['action', 'reason', 'targetId'].filter((k) => k in dto)).toEqual([]);
  });

  it('can fail: a leaked row column is named by the strict schema', () => {
    expect(() =>
      expectContract(AgentEventDTOSchema, { ...toAgentEventDTO(row), userId: row.userId }),
    ).toThrow(/userId/);
  });
});

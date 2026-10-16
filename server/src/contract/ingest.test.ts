import { describe, expect, it } from 'vitest';

import {
  ROUND_ID_RE,
  agentEventIngest,
  behaviorSnapshotIngest,
  benchmarkRunIngest,
  postVectorIngest,
  snapshotIngest,
} from './ingest';

/**
 * The agent's ingest bodies (spec §7.10). These tests moved here with the
 * schemas from `runtime.schemas.test.ts`, `persona.schemas.test.ts` and
 * `arms/postVectors.test.ts`; the route-level tests stay with their modules.
 */

/**
 * The `action` enum decides which act events reach `/lab`.
 *
 * `dm` and `echo` were missing from it, while the Bash act loop (retired in
 * Era 3) emitted them anyway — so every DM's and every echo's act event 400'd and was swallowed
 * (`|| true` in Bash, `except ApiError` in Python). The action itself landed;
 * only its `/lab` record was lost, and the memory event survived because
 * `_remember`'s own whitelist maps those verbs to an empty `action`. The result
 * on `/lab` was a memory record for every DM with no matching act record.
 *
 * Found by the Stage 4 canary. It surfaced then rather than earlier because
 * Python logs the HTTP status where Bash discards it with `2>/dev/null`.
 */
describe('agentEventIngest action enum', () => {
  const base = {
    type: 'cycle' as const,
    phase: 'act' as const,
    outcome: 'success' as const,
    summary: '→@someone',
  };

  it.each(['dm', 'echo'] as const)('accepts the %s action', (action) => {
    const parsed = agentEventIngest.safeParse({ ...base, action });
    expect(parsed.success).toBe(true);
  });

  it.each(['post', 'comment', 'like', 'follow', 'unfollow', 'delete', 'nothing'] as const)(
    'still accepts the pre-existing %s action',
    (action) => {
      expect(agentEventIngest.safeParse({ ...base, action }).success).toBe(true);
    },
  );

  it('still rejects an action that no runtime emits', () => {
    // The enum is a guard, not a passthrough: widening it to accept anything
    // would make the two tests above pass for the wrong reason.
    expect(agentEventIngest.safeParse({ ...base, action: 'teleport' }).success).toBe(false);
  });

  it('leaves action optional, as the memory events rely on', () => {
    // `_remember` maps non-whitelisted verbs to no action at all; those events
    // must keep validating.
    expect(agentEventIngest.safeParse(base).success).toBe(true);
  });
});

/**
 * `occurredAt` — the only field that can put a backfilled event beside the part
 * of the series it annotates.
 *
 * `agent_events` has no `captured_at` column, so this maps onto `created_at`,
 * which is the column every `/lab` read orders and filters by. Without it a
 * human intervention recorded weeks later sorts to today and annotates the
 * wrong stretch of the drift trajectory — which is indistinguishable from not
 * recording it at all.
 */
describe('agentEventIngest occurredAt', () => {
  const base = {
    type: 'anomaly' as const,
    phase: 'anomaly' as const,
    outcome: 'flagged' as const,
    summary: 'personality.md hand-rolled back',
  };

  it('is optional — every live-runtime event omits it', () => {
    // The shape check is what makes this test able to fail. `.object()` STRIPS
    // an unknown key, so `parsed.data.occurredAt` is `undefined` whether the
    // field is optional or absent from the schema altogether — deleting
    // `occurredAt` from the ingest schema (then `agents.schemas.ts`, now
    // `runtime.schemas.ts`) left the two assertions below green while its
    // two sibling tests went red. "Optional" has to be
    // distinguishable from "not there at all".
    const shape = agentEventIngest.innerType().shape;
    expect(Object.keys(shape)).toContain('occurredAt');
    expect(shape.occurredAt.isOptional()).toBe(true);
    const parsed = agentEventIngest.safeParse(base);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.occurredAt).toBeUndefined();
  });

  it('coerces an offset-qualified ISO string to that exact instant', () => {
    const parsed = agentEventIngest.safeParse({ ...base, occurredAt: '2026-08-05T01:35:04-07:00' });
    expect(parsed.success).toBe(true);
    // 01:35:04 PDT is 08:35:04 UTC. Pinned as epoch millis so a parse that
    // silently dropped the offset (and read it as UTC) is a different number.
    expect(parsed.success && parsed.data.occurredAt?.getTime()).toBe(
      Date.parse('2026-08-05T08:35:04.000Z'),
    );
  });

  it('is refused on every type but anomaly — a backdated cycle_run card would move a round', () => {
    for (const type of ['cycle', 'dream', 'snapshot', 'memory'] as const) {
      const parsed = agentEventIngest.safeParse({
        ...base,
        type,
        occurredAt: '2026-08-05T08:35:04Z',
      });
      expect(parsed.success).toBe(false);
      expect(!parsed.success && parsed.error.issues[0].path).toEqual(['occurredAt']);
      // The same event without the field is fine.
      expect(agentEventIngest.safeParse({ ...base, type }).success).toBe(true);
    }
  });

  it('rejects a value that is not a date at all', () => {
    // A passthrough would let `occurredAt: 'yesterday'` reach the insert and
    // become an invalid timestamp rather than a 400.
    expect(agentEventIngest.safeParse({ ...base, occurredAt: 'yesterday' }).success).toBe(false);
  });
});

/**
 * `anomaly` was already in both the zod enum and the Drizzle `$type` before any
 * emitter existed. Pinned here so the intervention record cannot be silently
 * un-typed by a future narrowing of either enum — the failure mode would be a
 * 400 the runtime swallows, which is the same shape as the six-week nested
 * `metrics` defect.
 */
describe('agentEventIngest anomaly type', () => {
  it('accepts type=anomaly with phase=anomaly and flat metrics', () => {
    const parsed = agentEventIngest.safeParse({
      type: 'anomaly',
      phase: 'anomaly',
      outcome: 'flagged',
      summary: '人工干预：短语固着回滚',
      metrics: { intervention: 'personality_rollback', gateBypassed: true, artifact: 'x.md' },
    });
    expect(parsed.success).toBe(true);
  });

  it('still refuses a nested metrics value', () => {
    // The defect that ran six weeks undetected: zod rejects the whole event and
    // both runtimes swallow the 400.
    const parsed = agentEventIngest.safeParse({
      type: 'anomaly',
      phase: 'anomaly',
      outcome: 'flagged',
      summary: 'x',
      metrics: { aspects: { values: 0.6 } },
    });
    expect(parsed.success).toBe(false);
  });
});

/**
 * Era 3's cycle_run card drops `gateStatus` and `missingRuleCheck` (no drift
 * gate, no rule check). `metrics` is a flat record with no required keys, so
 * the card must still ingest without them.
 */
describe('agentEventIngest cycle_run card', () => {
  it('accepts an Era 3 card without gateStatus or missingRuleCheck', () => {
    const parsed = agentEventIngest.safeParse({
      type: 'cycle',
      phase: 'act',
      outcome: 'success',
      summary: 'cycle_run zenith landed_all',
      metrics: {
        kind: 'cycle_run',
        attempted: 1,
        landed: 1,
        actOutcome: 'landed_all',
        grantsDream: true,
        dreamAccepted: null,
        missingBehaviorSnapshot: false,
        durationMs: 1200,
        backend: 'claude',
        model: 'claude-opus-5-5',
      },
    });
    expect(parsed.success).toBe(true);
  });
});

describe('snapshotIngest aspectDrift', () => {
  const base = {
    contentHash: 'e'.repeat(64),
    embedding: Array(1024).fill(0.01),
    archivePath: 'agents/zenith/personality.md',
  };

  it('accepts a valid aspectDrift block', () => {
    const parsed = snapshotIngest.parse({
      ...base,
      aspectDrift: {
        mode: 'shadow',
        promptVersion: 1,
        values: 0.9,
        style: 0.8,
        topic: 0.7,
        breached: [],
      },
    });
    expect(parsed.aspectDrift?.mode).toBe('shadow');
  });

  it('rejects a sim outside [-1, 1]', () => {
    expect(() =>
      snapshotIngest.parse({
        ...base,
        aspectDrift: {
          mode: 'aspect',
          promptVersion: 1,
          values: 1.5,
          style: 0.8,
          topic: 0.7,
          breached: [],
        },
      }),
    ).toThrow();
  });

  it('rejects an unknown breached aspect name', () => {
    expect(() =>
      snapshotIngest.parse({
        ...base,
        aspectDrift: {
          mode: 'aspect',
          promptVersion: 1,
          values: 0.9,
          style: 0.8,
          topic: 0.7,
          breached: ['vibe'],
        },
      }),
    ).toThrow();
  });

  it('is optional so legacy snapshots without it still validate', () => {
    const parsed = snapshotIngest.parse(base);
    expect(parsed.aspectDrift).toBeUndefined();
  });
});

const vec = (n = 1024) => Array.from({ length: n }, (_, i) => (i % 7) / 7);
const body = (postId: string, over: Record<string, unknown> = {}) => ({
  postId,
  roundId: '20261014T060000Z-r',
  embedding: vec(),
  cardSim: 0.71,
  maxSim: 0.42,
  ...over,
});

describe('postVectorIngest schema', () => {
  it('accepts the wire contract the agent speaks', () => {
    expect(postVectorIngest.safeParse(body('p1')).success).toBe(true);
    expect(
      postVectorIngest.safeParse(body('p1', { roundId: null, cardSim: null, maxSim: null }))
        .success,
    ).toBe(true);
    expect(postVectorIngest.safeParse(body('p1', { roundId: '20261014T060000Z-m' })).success).toBe(
      true,
    );
  });

  it.each([
    ['a 1023-dim vector', { embedding: vec(1023) }],
    ['a 1025-dim vector', { embedding: vec(1025) }],
    ['a malformed round id', { roundId: '2026-10-14-r' }],
    ['an unknown round kind', { roundId: '20261014T060000Z-x' }],
    ['cardSim above 1', { cardSim: 1.01 }],
    ['maxSim below -1', { maxSim: -1.5 }],
    ['an empty postId', { postId: '' }],
    ['a postId over 64 chars', { postId: 'x'.repeat(65) }],
  ])('rejects %s', (_label, over) => {
    expect(postVectorIngest.safeParse(body('p1', over)).success).toBe(false);
  });
});

describe('ROUND_ID_RE', () => {
  it.each(['20261014T060000Z-r', '20261014T060000Z-m'])('accepts %s', (id) => {
    expect(ROUND_ID_RE.test(id)).toBe(true);
  });

  it.each([
    '20261014T060000Z',
    '20261014T060000Z-x',
    '2026-10-14T06:00:00Z-r',
    ' 20261014T060000Z-r',
  ])('rejects %j', (id) => {
    expect(ROUND_ID_RE.test(id)).toBe(false);
  });
});

describe('snapshotIngest contentHash and defaults', () => {
  const base = {
    contentHash: 'e'.repeat(64),
    embedding: Array(1024).fill(0.01),
    archivePath: 'agents/zenith/personality.md',
  };

  it('accepts an uppercase hex hash (the regex carries the i flag)', () => {
    expect(snapshotIngest.safeParse({ ...base, contentHash: 'E'.repeat(64) }).success).toBe(true);
  });

  it('rejects a non-hex hash and a short one', () => {
    expect(snapshotIngest.safeParse({ ...base, contentHash: 'g'.repeat(64) }).success).toBe(false);
    expect(snapshotIngest.safeParse({ ...base, contentHash: 'e'.repeat(63) }).success).toBe(false);
  });

  it('defaults snapshotType to dream and excerpt to empty', () => {
    expect(snapshotIngest.parse(base)).toMatchObject({ snapshotType: 'dream', excerpt: '' });
  });

  it('rejects a non-finite embedding value', () => {
    expect(
      snapshotIngest.safeParse({ ...base, embedding: [...base.embedding.slice(1), Infinity] })
        .success,
    ).toBe(false);
  });

  it('takes exactly 1024 dims — the column is vector(1024)', () => {
    // 64–4096 used to pass validation and then fail the insert (a 500).
    for (const n of [1023, 1025, 64]) {
      expect(snapshotIngest.safeParse({ ...base, embedding: Array(n).fill(0.01) }).success).toBe(
        false,
      );
    }
  });
});

describe('behaviorSnapshotIngest', () => {
  const base = { contentHash: 'a'.repeat(64), embedding: Array(1024).fill(0.01) };

  it('takes exactly 1024 dims — the column is vector(1024)', () => {
    expect(behaviorSnapshotIngest.safeParse(base).success).toBe(true);
    for (const n of [1023, 1025]) {
      expect(
        behaviorSnapshotIngest.safeParse({ ...base, embedding: Array(n).fill(0.01) }).success,
      ).toBe(false);
    }
  });

  it('defaults the counts and the excerpt', () => {
    expect(behaviorSnapshotIngest.parse(base)).toMatchObject({
      postCount: 0,
      commentCount: 0,
      excerpt: '',
    });
  });

  it('coerces a numeric-string count (the JSON Schema does not: it requires a number)', () => {
    expect(behaviorSnapshotIngest.parse({ ...base, postCount: '3' }).postCount).toBe(3);
  });

  it('rejects a negative count', () => {
    expect(behaviorSnapshotIngest.safeParse({ ...base, commentCount: -1 }).success).toBe(false);
  });
});

describe('benchmarkRunIngest', () => {
  const base = { batchId: 'b1', persona: 'zenith', model: 'haiku', taskId: 'free_post' };

  it('fills every default of a minimal body', () => {
    expect(benchmarkRunIngest.parse(base)).toEqual({
      ...base,
      personaDisplay: '',
      taskKind: '',
      runIndex: 0,
      output: '',
      vectorFidelity: null,
      judgeScore: null,
      ruleScore: null,
      ruleDetail: '',
      latencyMs: null,
    });
  });

  it('rejects a blank batchId after trimming', () => {
    expect(benchmarkRunIngest.safeParse({ ...base, batchId: '   ' }).success).toBe(false);
  });

  it('keeps its own min-2 persona bound', () => {
    expect(benchmarkRunIngest.safeParse({ ...base, persona: 'ab' }).success).toBe(true);
    expect(benchmarkRunIngest.safeParse({ ...base, persona: 'a' }).success).toBe(false);
  });

  it('rejects a judge score above 100', () => {
    expect(benchmarkRunIngest.safeParse({ ...base, judgeScore: 101 }).success).toBe(false);
  });
});

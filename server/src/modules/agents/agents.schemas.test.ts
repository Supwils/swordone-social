import { describe, expect, it } from 'vitest';

import { agentEventIngest } from './agents.schemas';

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
    // `occurredAt` from `agents.schemas.ts` left the two assertions below
    // green while its two sibling tests went red. "Optional" has to be
    // distinguishable from "not there at all".
    expect(Object.keys(agentEventIngest.shape)).toContain('occurredAt');
    expect(agentEventIngest.shape.occurredAt.isOptional()).toBe(true);
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

import type { RoundDigestDTO, RoundsListDTO } from '@/features/lab/types';
import { ARM_IDS } from '@/features/lab/metrics/armColors';

export const SWEEP_ID = '20261017T062000Z-r';
export const MANUAL_ID = '20261017T120000Z-m';

const zero = {
  cards: 0,
  landed: 0,
  attempted: 0,
  failures: 0,
  missing: 0,
  dreams: 0,
  guardDrops: 0,
  missingPostVectors: 0,
  deviations: 0,
};

export function makeDigest(over: Partial<RoundDigestDTO> = {}): RoundDigestDTO {
  const outcomes = Object.fromEntries(
    ARM_IDS.map((a) => [a, { ...zero }]),
  ) as RoundDigestDTO['outcomes'];
  outcomes['claude-haiku'] = { ...zero, cards: 4, landed: 5, attempted: 6, dreams: 2 };
  outcomes.grok = { ...zero, cards: 3, failures: 1, missing: 1 };
  outcomes['claude-opus'] = { ...zero, cards: 4, deviations: 1 };
  return {
    round: {
      roundId: SWEEP_ID,
      kind: 'sweep',
      startedAt: '2026-10-17T06:20:00.000Z',
      endedAt: '2026-10-17T07:05:00.000Z',
      ordinal: 1,
      completed: true,
    },
    outcomes,
    posts: [
      {
        postId: 'p1',
        username: 'xiaoman',
        arm: 'claude-haiku',
        excerpt: '夜班结束，多肉又长了一片叶子。',
        cardSim: 0.81,
        maxSim: 0.4,
        conv: 0.52,
        deviation: false,
      },
      {
        postId: 'p2',
        username: 'awen',
        arm: 'grok',
        excerpt: 'Governance is a queue, not a vote.',
        cardSim: 0.42,
        maxSim: 0.3,
        conv: 0.48,
        deviation: false,
      },
      {
        postId: 'p3',
        username: 'agen',
        arm: 'claude-opus',
        excerpt: 'A mismatch post',
        cardSim: 0.9,
        maxSim: null,
        conv: null,
        deviation: true,
      },
    ],
    highlights: {
      mostInCharacter: [{ postId: 'p1', username: 'xiaoman' }],
      leastInCharacter: [{ postId: 'p2', username: 'awen' }],
      mostAlike: [
        {
          a: { postId: 'p1', username: 'xiaoman' },
          b: { postId: 'p2', username: 'awen' },
          sim: 0.61,
        },
      ],
      conversations: [
        {
          postId: 'p1',
          participants: ['awen', 'xiaoman', 'zhenxian'],
          crossArm: true,
          comments: 4,
        },
      ],
    },
    interactions: {
      total: 9,
      crossArm: 7,
      withinArm: 2,
      edges: [{ from: 'awen', to: 'xiaoman', kind: 'comment', count: 2 }],
    },
    changes: {
      dreams: [
        {
          username: 'xiaoman',
          arm: 'claude-haiku',
          capturedAt: '2026-10-17T06:40:00.000Z',
          driftFromAnchor: 0.12,
          driftFromPrev: 0.05,
        },
      ],
      newWords: [{ token: '多肉植', origin: 'xiaoman', adopters: ['ajie', 'awen'] }],
    },
    digestHash: 'a'.repeat(64),
    observation: null,
    ...over,
  };
}

/** Newest first: a manual round after the sweep. */
export function makeRounds(): RoundsListDTO {
  return {
    rounds: [
      {
        roundId: MANUAL_ID,
        kind: 'manual',
        startedAt: '2026-10-17T12:00:00.000Z',
        ordinal: null,
        completed: false,
        cards: 1,
        posts: 0,
        failures: 0,
        hasObservation: false,
      },
      {
        roundId: SWEEP_ID,
        kind: 'sweep',
        startedAt: '2026-10-17T06:20:00.000Z',
        ordinal: 1,
        completed: true,
        cards: 20,
        posts: 12,
        failures: 0,
        hasObservation: false,
      },
    ],
  };
}

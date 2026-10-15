/**
 * Arms-report fixtures shared by the Era 3 dashboard suites.
 *
 * `seededReport()` is a mid-window report (7/12 rounds, not frozen) whose
 * numbers are all distinct so a cell that printed its neighbour shows up.
 * `emptyReport()` is the zero-round shape the server returns before round 1:
 * every statistic null, every verdict `collecting`, contagion `collecting`.
 */
import type { ArmId, ArmsReportDTO, MetricBlock, SeriesPoint } from '@/features/lab/types';

export const ARMS: ArmId[] = ['openai', 'grok', 'gemini', 'claude-opus', 'claude-haiku'];

const MODELS: Record<ArmId, string> = {
  openai: 'codex:gpt-5.6-luna',
  grok: 'grok:grok-4.6',
  gemini: 'cursor:gemini-3.7-flash-high',
  'claude-opus': 'claude:claude-opus-5-5',
  'claude-haiku': 'claude:claude-haiku-5-5',
};

const ACCOUNTS: Record<ArmId, string[]> = {
  openai: ['zhenxian', 'caiyuan', 'laozhou', 'shengsheng'],
  grok: ['awen', 'xiaolin', 'jiucang', 'laoqian'],
  gemini: ['xiangsu', 'ajie', 'tangtang', 'lanlan'],
  'claude-opus': ['agen', 'xiaoyu', 'xiaobei', 'maike'],
  'claude-haiku': ['dashu', 'zhangfawu', 'xiaoman', 'linkuaiji'],
};

const ROUND_IDS = ['20261015T060000Z-r', '20261017T060000Z-r', '20261019T060000Z-r'];

function points(values: Array<number | null>): SeriesPoint[] {
  return values.map((value, i) => ({
    roundId: ROUND_IDS[i],
    ordinal: i + 1,
    value,
    n: value === null ? 0 : 3,
  }));
}

function block(key: MetricBlock['key'], base: number, frozenAt: string | null): MetricBlock {
  return {
    key,
    series: ARMS.map((arm, i) => ({
      arm,
      points: points([base + i * 0.01, i === 2 ? null : base + i * 0.01 + 0.002, base + 0.004]),
    })),
    population: key === 'convergence' ? points([0.611, 0.618, 0.624]) : undefined,
    accounts: ARMS.flatMap((arm) =>
      ACCOUNTS[arm].map((username) => ({ username, arm, value: 0.001, n: 3, level: base })),
    ),
    arms: ARMS.map((arm, i) => ({
      arm,
      mean: i === 4 ? null : -0.0121 - i * 0.0011,
      sd: i === 4 ? null : 0.0043 + i * 0.0002,
      accounts: i === 4 ? 1 : 4 - (i % 2),
      qualifies: i !== 4,
    })),
    verdict: { status: 'collecting', between: 0.0187, within: 0.0262, frozenAt },
    companions:
      key === 'fidelity'
        ? [
            { label: 'level', arms: ARMS.map((arm, i) => ({ arm, value: 0.701 + i / 100 })) },
            { label: 'candidates', arms: ARMS.map((arm) => ({ arm, value: null })) },
          ]
        : [{ label: 'level', arms: ARMS.map((arm) => ({ arm, value: 0.555 })) }],
  };
}

export function seededReport(frozenAt: string | null = null): ArmsReportDTO {
  const repetition = block('repetition', 0.08, frozenAt);
  repetition.arms = ARMS.map((arm, i) => ({
    arm,
    mean: 0.125 + i * 0.05,
    sd: 0.031,
    accounts: 4,
    qualifies: true,
  }));
  repetition.verdict = { status: 'insufficient', between: null, within: null, frozenAt };
  repetition.companions = [
    { label: 'meanMaxSim', arms: ARMS.map((arm) => ({ arm, value: 0.734 })) },
  ];
  return {
    generatedAt: '2026-10-20T08:00:00.000Z',
    arms: ARMS.map((id) => ({ id, model: MODELS[id], accounts: ACCOUNTS[id] })),
    rounds: ROUND_IDS.map((roundId, i) => ({
      roundId,
      kind: 'sweep',
      startedAt: `2026-10-${15 + i * 2}T06:00:00.000Z`,
      cards: 18,
      completed: true,
      ordinal: i + 1,
      inWindow: true,
    })),
    completedRounds: 7,
    targetRounds: 12,
    minArmRounds: 9,
    armRounds: { openai: 7, grok: 6, gemini: 7, 'claude-opus': 9, 'claude-haiku': 2 },
    metrics: {
      fidelity: block('fidelity', 0.72, frozenAt),
      repetition,
      convergence: block('convergence', 0.6, frozenAt),
    },
    exploratory: {
      homophily: {
        matrix: {
          openai: { openai: 11, grok: 2, gemini: 3, 'claude-opus': 4, 'claude-haiku': 5 },
          grok: { openai: 6, grok: 13, gemini: 0, 'claude-opus': 1, 'claude-haiku': 2 },
          gemini: { openai: 0, grok: 0, gemini: 0, 'claude-opus': 0, 'claude-haiku': 0 },
          'claude-opus': { openai: 7, grok: 8, gemini: 9, 'claude-opus': 17, 'claude-haiku': 10 },
          'claude-haiku': { openai: 1, grok: 1, gemini: 1, 'claude-opus': 1, 'claude-haiku': 19 },
        },
        arms: ARMS.map((arm, i) => ({
          arm,
          out: 20 + i,
          crossBoardOut: 14 + i,
          within: 3 + i,
          share: i === 2 ? null : 0.214 + i * 0.01,
          expected: i === 2 ? null : 0.176,
          ratio: i === 2 ? null : 1.216 + i * 0.1,
        })),
      },
      contagion: {
        status: 'ok',
        arms: ARMS.map((arm, i) => ({
          arm,
          innovations: 30 + i,
          adopted: 2 + i,
          rate: 0.0667 + i * 0.01,
        })),
        top: [
          {
            token: '慢生活',
            origin: 'xiaoman',
            originArm: 'claude-haiku',
            adopters: 5,
            adopterArms: ['openai', 'grok'],
          },
        ],
      },
      reliability: ARMS.map((arm, i) => ({
        arm,
        expected: 28,
        cards: 27 - i,
        fails: i,
        missing: 1 + i,
        attempted: 50 + i,
        landed: 40 + i,
        dreamsAccepted: 12 + i,
        dreamsFailed: i,
        guardDrops: 2,
        missingPostVectors: i === 3 ? 4 : 0,
        deviations: i === 1 ? 3 : 0,
      })),
    },
  };
}

function emptyBlock(key: MetricBlock['key']): MetricBlock {
  return {
    key,
    series: ARMS.map((arm) => ({ arm, points: [] })),
    population: key === 'convergence' ? [] : undefined,
    accounts: [],
    arms: ARMS.map((arm) => ({ arm, mean: null, sd: null, accounts: 0, qualifies: false })),
    verdict: { status: 'collecting', between: null, within: null, frozenAt: null },
    companions: [],
  };
}

export function emptyReport(): ArmsReportDTO {
  return {
    generatedAt: '2026-10-14T08:00:00.000Z',
    arms: ARMS.map((id) => ({ id, model: MODELS[id], accounts: ACCOUNTS[id] })),
    rounds: [],
    completedRounds: 0,
    targetRounds: 12,
    minArmRounds: 9,
    armRounds: { openai: 0, grok: 0, gemini: 0, 'claude-opus': 0, 'claude-haiku': 0 },
    metrics: {
      fidelity: emptyBlock('fidelity'),
      repetition: emptyBlock('repetition'),
      convergence: emptyBlock('convergence'),
    },
    exploratory: {
      homophily: {
        matrix: {} as ArmsReportDTO['exploratory']['homophily']['matrix'],
        arms: [],
      },
      contagion: { status: 'collecting', arms: [], top: [] },
      reliability: [],
    },
  };
}

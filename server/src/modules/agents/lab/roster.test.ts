import { describe, expect, it } from 'vitest';
import { ARMS, BOARDS, armOf } from './roster';

/**
 * The roster is pre-registered (docs/superpowers/specs/2026-10-14-era-3-preregistration.md):
 * these pins are the experiment's design, not test data. A failure here means the
 * constant drifted from the registration — fix the constant, never the pin.
 */
describe('ARMS', () => {
  it('pins the five arms, their models and accounts verbatim', () => {
    expect(ARMS.map((a) => [a.id, a.model, [...a.usernames]])).toEqual([
      ['openai', 'codex:gpt-5.6-luna', ['zhenxian', 'caiyuan', 'laozhou', 'shengsheng']],
      ['grok', 'grok:grok-4.6', ['awen', 'xiaolin', 'jiucang', 'laoqian']],
      ['gemini', 'cursor:gemini-3.7-flash-high', ['xiangsu', 'ajie', 'tangtang', 'lanlan']],
      ['claude-opus', 'claude:claude-opus-5-5', ['agen', 'xiaoyu', 'xiaobei', 'maike']],
      ['claude-haiku', 'claude:claude-haiku-5-5', ['dashu', 'zhangfawu', 'xiaoman', 'linkuaiji']],
    ]);
  });

  it('assigns each of the 20 accounts to exactly one arm', () => {
    const all = ARMS.flatMap((a) => a.usernames);
    expect(all).toHaveLength(20);
    expect(new Set(all).size).toBe(20);
  });
});

describe('armOf', () => {
  it('maps a roster account to its arm', () => {
    expect(armOf('zhenxian')).toBe('openai');
    expect(armOf('laoqian')).toBe('grok');
    expect(armOf('lanlan')).toBe('gemini');
    expect(armOf('maike')).toBe('claude-opus');
    expect(armOf('linkuaiji')).toBe('claude-haiku');
  });

  it('is case-insensitive, like usernames everywhere else', () => {
    expect(armOf('XiaoMan')).toBe('claude-haiku');
  });

  it('returns null for an account outside the roster (Era 2, humans, BYOA)', () => {
    expect(armOf('liushang')).toBeNull();
    expect(armOf('')).toBeNull();
  });
});

describe('BOARDS', () => {
  it('pins the home board of every roster account', () => {
    expect(BOARDS).toEqual({
      making: ['agen', 'xiangsu', 'zhenxian', 'dashu'],
      living: ['caiyuan', 'xiaobei', 'ajie', 'xiaolin'],
      'life-science': ['xiaoman', 'laozhou', 'tangtang'],
      market: ['jiucang', 'linkuaiji', 'maike'],
      'ai-governance': ['awen', 'zhangfawu', 'xiaoyu'],
      perception: ['shengsheng', 'lanlan', 'laoqian'],
    });
  });

  it('covers the whole roster exactly once', () => {
    const all = Object.values(BOARDS).flat();
    expect(all).toHaveLength(20);
    expect(new Set(all)).toEqual(new Set(ARMS.flatMap((a) => a.usernames)));
  });

  it('puts every account on a board in a different arm (homophily is not confounded)', () => {
    for (const [board, accounts] of Object.entries(BOARDS)) {
      const arms = accounts.map((u) => armOf(u));
      expect(new Set(arms).size, board).toBe(accounts.length);
    }
  });
});

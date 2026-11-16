import { describe, expect, it } from 'vitest';
import { firstClause, opensWithTime } from './opening';

describe('opensWithTime', () => {
  it.each([
    '周日傍晚六点十五，我去窗台看了一眼。',
    '星期三早上没睡醒',
    '今晚加班到十点',
    '凌晨三点还在改稿子',
    '7点40，第三天的睡眠记录',
    'Thursday evening, 6 PM. The headline says',
    'At 6:15 PM on Sunday I checked the windowsill',
    'Tonight the shop was quiet',
  ])('flags a clock opening: %s', (text) => {
    expect(opensWithTime(text)).toBe(true);
  });

  it.each([
    '罗勒掐顶之后侧芽会更快。',
    '油价又涨了，周三才去加的油。',
    'A quiet thought about compilers',
    'Shrimp dumplings again; three wrappers broke on Monday.',
    '',
  ])('passes an opening that is not about the clock: %s', (text) => {
    expect(opensWithTime(text)).toBe(false);
  });
});

describe('firstClause', () => {
  it('stops at the first clause break and caps Chinese at 24 code points', () => {
    expect(firstClause('  一二三，四五六')).toBe('一二三');
    expect(Array.from(firstClause('字'.repeat(40)))).toHaveLength(24);
  });
});

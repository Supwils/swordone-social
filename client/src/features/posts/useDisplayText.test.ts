import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDisplayText } from './useDisplayText';

describe('useDisplayText', () => {
  it('returns the fallback for short posts (<10 non-empty lines)', () => {
    // Tightened from <5 — short poetic posts (e.g. 4-5 line haiku) shouldn't
    // be flattened by the agent-text normalizer.
    const { result } = renderHook(() =>
      useDisplayText('窗外的雨\n屏幕还亮着\n像一盏忘记熄的灯', 'fallback'),
    );
    expect(result.current).toBe('fallback');
  });

  it('preserves a 5-line haiku — does NOT trigger case-1 join', () => {
    // Direct regression guard against the bug where liushang-style short
    // poems were being flattened into a single line.
    const haiku = '窗外的雨\n不知何时停了\n屏幕还亮着\n像一盏\n忘记熄的灯';
    const { result } = renderHook(() => useDisplayText(haiku, haiku));
    expect(result.current).toBe(haiku);
  });

  it('joins entirely-fragmented posts (>80% of lines ≤6 chars, ≥10 lines)', () => {
    const fragmented = ['我', '是', '谁', '在', '哪', '#', 'AI', '#', 'now', 'AGI'].join('\n');
    const { result } = renderHook(() => useDisplayText(fragmented, 'orig'));
    expect(result.current).toBe('我是谁在哪#AI#nowAGI');
  });

  it('joins runs of ≥4 short lines but keeps long lines intact', () => {
    // ≥10 non-empty lines so case-2 logic runs; mixed case
    const mixed = [
      'This is a normal paragraph.',
      'Another normal one here.',
      'And a third normal paragraph.',
      'Fourth paragraph.',
      'Fifth.',
      '',
      '#',
      'mTOR',
      '#',
      '分子营养学',
      '',
      'Another paragraph with normal length.',
    ].join('\n');
    const { result } = renderHook(() => useDisplayText(mixed, 'orig'));
    expect(result.current).toContain('#mTOR#分子营养学');
    expect(result.current).toContain('This is a normal paragraph.');
    expect(result.current).toContain('Another paragraph with normal length.');
  });

  it('does NOT join runs shorter than 4 short lines', () => {
    // Two leading short lines, then long ones — short run is only 2, stays separate.
    const text = [
      '#',
      'AI',
      'normal long enough line one',
      'normal long enough line two',
      'normal long enough line three',
      'normal long enough line four',
      'normal long enough line five',
      'normal long enough line six',
      'normal long enough line seven',
      'normal long enough line eight',
    ].join('\n');
    const { result } = renderHook(() => useDisplayText(text, 'orig'));
    expect(result.current).toBe(text);
  });

  it('case-1 dominates when most lines are short, even with a long-line breaker', () => {
    // 11 short + 1 long = 91.7% short, exceeds the 80% case-1 threshold.
    const text = [
      '1',
      '2',
      '3',
      'this line is longer than six chars',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      'a',
      'b',
    ].join('\n');
    const { result } = renderHook(() => useDisplayText(text, 'orig'));
    expect(result.current).toBe('123this line is longer than six chars456789ab');
  });

  it('memoizes — same input produces same reference', () => {
    const text = '我\n是\n谁\n在\n哪\n#\nAI\n#\nnow\nAGI';
    const { result, rerender } = renderHook(
      ({ t, fb }: { t: string; fb: string }) => useDisplayText(t, fb),
      { initialProps: { t: text, fb: 'orig' } },
    );
    const first = result.current;
    rerender({ t: text, fb: 'orig' });
    expect(result.current).toBe(first);
  });
});

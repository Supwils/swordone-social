import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { formatRelative, formatAbsolute } from './formatDate';

/**
 * `formatRelative` is a cascade of four boundaries (45s / 1h / 24h / 7d) and a
 * year check. Every one of them is an off-by-one waiting to happen, and the
 * output is read by users on every post and comment, so each edge is pinned
 * from both sides.
 *
 * Time is frozen at a mid-month, mid-year instant so that "7 days ago" cannot
 * cross a month or year boundary and change which branch is under test.
 */
const NOW = new Date('2026-06-15T12:00:00.000Z');
const ago = (seconds: number): string => new Date(NOW.getTime() - seconds * 1000).toISOString();

describe('formatRelative', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports "just now" for anything under 45 seconds', () => {
    expect(formatRelative(ago(0))).toBe('just now');
    expect(formatRelative(ago(44))).toBe('just now');
  });

  it('switches to minutes at exactly 45 seconds', () => {
    // The 45s boundary rounds to "1m" rather than falling back to "just now".
    expect(formatRelative(ago(45))).toBe('1m');
  });

  it('reports minutes up to the hour boundary', () => {
    expect(formatRelative(ago(60 * 5))).toBe('5m');
    expect(formatRelative(ago(60 * 59))).toBe('59m');
  });

  it('switches to hours at exactly one hour', () => {
    expect(formatRelative(ago(3600))).toBe('1h');
    expect(formatRelative(ago(3600 * 23))).toBe('23h');
  });

  it('switches to days at exactly 24 hours', () => {
    expect(formatRelative(ago(86400))).toBe('1d');
    expect(formatRelative(ago(86400 * 6))).toBe('6d');
  });

  it('falls back to an absolute date at exactly 7 days', () => {
    // 7d is the first value that leaves the relative branch entirely.
    const out = formatRelative(ago(86400 * 7));
    expect(out).not.toMatch(/^\d+d$/);
    expect(out).toMatch(/\d/);
  });

  it('omits the year for same-year dates and includes it otherwise', () => {
    const sameYear = formatRelative('2026-01-05T00:00:00.000Z');
    const priorYear = formatRelative('2024-01-05T00:00:00.000Z');
    expect(sameYear).not.toContain('2026');
    expect(priorYear).toContain('2024');
  });

  it('does not emit a negative relative time for a future timestamp', () => {
    // Clock skew between server and browser can produce these; the output must
    // still be readable rather than "-3m".
    expect(formatRelative(new Date(NOW.getTime() + 60_000).toISOString())).toBe('just now');
  });

  it('returns an empty string for an unparseable timestamp', () => {
    expect(formatRelative('not-a-date')).toBe('');
    expect(formatRelative('')).toBe('');
  });
});

describe('formatAbsolute', () => {
  it('includes year, month, day and a time component', () => {
    const out = formatAbsolute('2026-03-09T14:35:00.000Z');
    expect(out).toContain('2026');
    expect(out).toMatch(/\d{1,2}:\d{2}/);
  });

  it('returns an empty string for an unparseable timestamp', () => {
    expect(formatAbsolute('not-a-date')).toBe('');
  });
});

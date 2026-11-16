import { describe, expect, it } from 'vitest';
import { safeReturnPath } from './useAuthGate';

describe('safeReturnPath', () => {
  it('keeps an in-app path with its query', () => {
    expect(safeReturnPath('/p/abc?x=1', '/feed')).toBe('/p/abc?x=1');
  });

  it.each([
    ['not a string', 42],
    ['missing', undefined],
    ['protocol-relative', '//evil.example'],
    ['backslash trick', '/\\evil.example'],
    ['absolute URL', 'https://evil.example'],
    ['relative path', 'p/abc'],
    ['the login page itself', '/login'],
    ['the register page', '/register'],
  ])('falls back for %s', (_label, from) => {
    expect(safeReturnPath(from, '/feed')).toBe('/feed');
  });
});

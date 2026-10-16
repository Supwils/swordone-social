import { describe, expect, it } from 'vitest';
import { env } from '../config/env';
import { isAllowedOrigin } from './origin';

describe('isAllowedOrigin', () => {
  it('allows a missing Origin (non-browser clients)', () => {
    expect(isAllowedOrigin(undefined, undefined)).toBe(true);
    expect(isAllowedOrigin(undefined, 'api.example.com')).toBe(true);
  });

  it('allows an origin on the CORS allowlist, whatever the host (split deploy)', () => {
    expect(env.CORS_ORIGINS.length).toBeGreaterThan(0);
    expect(isAllowedOrigin(env.CORS_ORIGINS[0], undefined)).toBe(true);
    expect(isAllowedOrigin(env.CORS_ORIGINS[0], 'api.example.com')).toBe(true);
  });

  it('rejects an unknown cross-origin', () => {
    expect(isAllowedOrigin('https://evil.example', undefined)).toBe(false);
    expect(isAllowedOrigin('https://evil.example', 'api.example.com')).toBe(false);
  });

  it('allows the request host itself (same-origin deploy)', () => {
    expect(isAllowedOrigin('https://api.example.com', 'api.example.com')).toBe(true);
    expect(isAllowedOrigin('http://api.example.com', 'api.example.com')).toBe(true);
  });

  it('does not treat a host suffix or another port as same-origin', () => {
    expect(isAllowedOrigin('https://api.example.com.evil.com', 'api.example.com')).toBe(false);
    expect(isAllowedOrigin('https://api.example.com:8443', 'api.example.com')).toBe(false);
  });
});

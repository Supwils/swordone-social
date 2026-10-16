import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { apiPath, http, isCredentialCheck, onUnauthorized } from './client';

/**
 * The real axios instance and interceptor, with only the network replaced:
 * the adapter answers every request with a 401, the way the server does both
 * for an expired session and for a wrong current password.
 */
const reject401: AxiosAdapter = (config: InternalAxiosRequestConfig) =>
  Promise.reject(
    new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, null, {
      status: 401,
      statusText: 'Unauthorized',
      headers: {},
      config,
      data: { error: { code: 'UNAUTHENTICATED', message: 'nope' } },
    }),
  );

let listener: ReturnType<typeof vi.fn<() => void>>;
const originalAdapter = http.defaults.adapter;

beforeEach(() => {
  listener = vi.fn<() => void>();
  onUnauthorized(listener);
  http.defaults.adapter = reject401;
});

afterEach(() => {
  http.defaults.adapter = originalAdapter;
});

/** Let the interceptor's queued microtask run. */
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('401 interceptor', () => {
  it('does not end the session on a wrong current password', async () => {
    // Settings → change password with a typo answered 401, and the global
    // handler signed the user out mid-form.
    await expect(http.post('/auth/password', {})).rejects.toBeTruthy();
    await flush();
    expect(listener).not.toHaveBeenCalled();
  });

  it('does not treat a failed login as a lost session', async () => {
    await expect(http.post('/auth/login', {})).rejects.toBeTruthy();
    await flush();
    expect(listener).not.toHaveBeenCalled();
  });

  it('still ends the session on a 401 from any other endpoint', async () => {
    await expect(http.get('/feed')).rejects.toBeTruthy();
    await flush();
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe('isCredentialCheck', () => {
  it('matches the credential endpoints with or without a base or query', () => {
    expect(isCredentialCheck('/auth/password')).toBe(true);
    expect(isCredentialCheck('/api/v1/auth/login?x=1')).toBe(true);
    expect(isCredentialCheck('https://api.example.com/api/v1/auth/password')).toBe(true);
    expect(isCredentialCheck('/auth/me')).toBe(false);
    expect(isCredentialCheck('/auth/passwordx')).toBe(false);
    expect(isCredentialCheck(undefined)).toBe(false);
  });
});

describe('apiPath', () => {
  it('encodes every interpolated value and keeps the literal parts', () => {
    expect(apiPath`/conversations/${'../users/x/follow?'}/read`).toBe(
      '/conversations/..%2Fusers%2Fx%2Ffollow%3F/read',
    );
    expect(apiPath`/users/${'a b'}/posts`).toBe('/users/a%20b/posts');
    expect(apiPath`/tags/${'c#'}`).toBe('/tags/c%23');
    expect(apiPath`/boards`).toBe('/boards');
    expect(apiPath`/x/${1}/${'y'}`).toBe('/x/1/y');
  });

  it('refuses a dot-segment value, which survives encoding and would be collapsed', () => {
    expect(() => apiPath`/posts/${'..'}/like`).toThrow(/dot-segment/);
    expect(() => apiPath`/posts/${'.'}/like`).toThrow(/dot-segment/);
    // Dots inside a longer value are an ordinary segment.
    expect(apiPath`/tags/${'a..b'}`).toBe('/tags/a..b');
  });
});

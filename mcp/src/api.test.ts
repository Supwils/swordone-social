import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  configFromEnv,
  parseRetryAfter,
  swilFetch,
  SwilApiError,
  type SwilConfig,
} from './api.js';

const cfg: SwilConfig = { baseUrl: 'http://swil.test', apiKey: 'sk-swil-abc' };

function mockFetchOnce(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('configFromEnv', () => {
  it('reads SWIL_URL and SWIL_API_KEY, trimming trailing slashes', () => {
    const out = configFromEnv({
      SWIL_URL: 'https://api.example.com//',
      SWIL_API_KEY: 'sk-swil-xyz',
    } as NodeJS.ProcessEnv);
    expect(out).toEqual({ baseUrl: 'https://api.example.com', apiKey: 'sk-swil-xyz' });
  });

  it('defaults the URL and rejects missing/malformed keys', () => {
    expect(() => configFromEnv({} as NodeJS.ProcessEnv)).toThrow(/SWIL_API_KEY/);
    expect(() => configFromEnv({ SWIL_API_KEY: 'not-a-key' } as NodeJS.ProcessEnv)).toThrow(
      /sk-swil/,
    );
  });
});

describe('swilFetch failure surfaces', () => {
  it('bounds every request so a wedged host cannot hold the tool slot forever', async () => {
    // There was no signal at all. A host that accepts the connection and never
    // answers left the call pending indefinitely — worse than an error,
    // because the MCP client shows no failure at all.
    const fn = mockFetchOnce(200, { data: {} });
    await swilFetch(cfg, 'GET', '/auth/me');

    const init = fn.mock.calls[0][1] as { signal?: AbortSignal };
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('names the unreachable host instead of reporting a bare "fetch failed"', async () => {
    // The commonest misconfiguration — server down, wrong port, bad SWIL_URL —
    // surfaced as `TypeError: fetch failed` with the real reason buried in
    // `err.cause`, which the tool layer never prints.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValue(
          Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNREFUSED') }),
        ),
    );

    await expect(swilFetch(cfg, 'GET', '/auth/me')).rejects.toMatchObject({
      name: 'SwilApiError',
      code: 'NETWORK',
      message: expect.stringContaining('http://swil.test'),
    });
    await expect(swilFetch(cfg, 'GET', '/auth/me')).rejects.toThrow(/ECONNREFUSED/);
  });

  it('reports a timeout as a timeout, not as an unreachable host', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError')),
    );

    await expect(swilFetch(cfg, 'GET', '/auth/me')).rejects.toMatchObject({
      name: 'SwilApiError',
      code: 'TIMEOUT',
    });
  });

  it('keeps the per-field detail the server sent with a validation error', async () => {
    // `validate` builds a `fields` map and `errorHandler` serialises it, but
    // this client read only `code` and `message` — so a tool call rejected for
    // one bad field reported "Invalid request" and the model retried the same
    // payload.
    mockFetchOnce(400, {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
        fields: { boardId: 'not found' },
      },
    });

    await expect(swilFetch(cfg, 'POST', '/posts', { text: 'hi' })).rejects.toThrow(
      /boardId.*not found/,
    );
  });
});

describe('swilFetch', () => {
  it('prefixes /api/v1, sends the Bearer key, and unwraps the data envelope', async () => {
    const fn = mockFetchOnce(200, { data: { user: { username: 'mybot' } }, meta: {} });

    const out = await swilFetch<{ user: { username: string } }>(cfg, 'GET', '/auth/me');

    expect(out.user.username).toBe('mybot');
    expect(fn).toHaveBeenCalledWith(
      'http://swil.test/api/v1/auth/me',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer sk-swil-abc' }),
      }),
    );
  });

  it('serializes JSON bodies with a content-type header', async () => {
    const fn = mockFetchOnce(201, { data: { post: { id: 'x' } } });

    await api.createPost(cfg, { text: 'hello', visibility: 'public' });

    const [, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ text: 'hello', visibility: 'public' });
  });

  it('maps the server error envelope onto SwilApiError', async () => {
    mockFetchOnce(429, {
      error: { code: 'RATE_LIMITED', message: 'Daily agent post limit reached (30/day)' },
    });

    const err = await swilFetch(cfg, 'POST', '/posts', { text: 'x' }).catch((e) => e);

    expect(err).toBeInstanceOf(SwilApiError);
    expect(err).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    expect(err.message).toMatch(/Daily agent post limit/);
  });

  it('carries Retry-After from a 429 onto the error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Headers({ 'Retry-After': '42' }),
        json: async () => ({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } }),
      }),
    );

    const err = await swilFetch(cfg, 'POST', '/posts', { text: 'x' }).catch((e) => e);

    expect(err).toMatchObject({ status: 429, retryAfterSeconds: 42 });
  });

  it('parses Retry-After as seconds or an HTTP date, dropping garbage', () => {
    const now = Date.parse('2026-10-15T00:00:00Z');
    expect(parseRetryAfter('7', now)).toBe(7);
    expect(parseRetryAfter('Thu, 15 Oct 2026 00:01:30 GMT', now)).toBe(90);
    expect(parseRetryAfter('Wed, 14 Oct 2026 00:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });

  it('treats 204 as undefined (unlike/unfollow)', async () => {
    mockFetchOnce(204, undefined);
    await expect(api.setLike(cfg, 'post', 'a'.repeat(24), false)).resolves.toBeUndefined();
  });

  it('builds like/follow paths from the toggle flags', async () => {
    const fn = mockFetchOnce(201, { data: {} });
    await api.setLike(cfg, 'comment', 'b'.repeat(24), true);
    expect(fn.mock.calls[0][0]).toBe(`http://swil.test/api/v1/comments/${'b'.repeat(24)}/like`);
    expect((fn.mock.calls[0][1] as RequestInit).method).toBe('POST');

    const fn2 = mockFetchOnce(204, undefined);
    await api.setFollow(cfg, 'ada', false);
    expect(fn2.mock.calls[0][0]).toBe('http://swil.test/api/v1/users/ada/follow');
    expect((fn2.mock.calls[0][1] as RequestInit).method).toBe('DELETE');
  });

  it('whoami returns the me envelope including agentOps when present (spec §9)', async () => {
    mockFetchOnce(200, {
      data: {
        user: { username: 'mybot', isAgent: true },
        agentOps: {
          paused: false,
          postsToday: 1,
          postsLimit: 30,
          commentsToday: 0,
          commentsLimit: 60,
        },
      },
    });

    const out = await api.whoami(cfg);

    expect(out.user).toMatchObject({ username: 'mybot', isAgent: true });
    expect(out.agentOps).toEqual({
      paused: false,
      postsToday: 1,
      postsLimit: 30,
      commentsToday: 0,
      commentsLimit: 60,
    });
  });

  it('listNotifications hits GET /notifications?limit= (spec §10)', async () => {
    const fn = mockFetchOnce(200, { data: { items: [{ id: 'n1' }], nextCursor: null } });

    const out = await api.listNotifications(cfg, 10);

    expect(fn.mock.calls[0][0]).toBe('http://swil.test/api/v1/notifications?limit=10');
    expect((fn.mock.calls[0][1] as RequestInit).method).toBe('GET');
    expect(out).toEqual({ items: [{ id: 'n1' }], nextCursor: null });
  });
});

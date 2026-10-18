import { describe, expect, it } from 'vitest';
import { captureException, initMonitoring } from './monitoring';
import { OBSERVER_TOKEN_HEADER } from '../modules/agents/rounds/observerToken';

// SENTRY_DSN is unset in the test env, so every call must be a silent no-op —
// the app runs with zero telemetry and nothing throws.
describe('monitoring (disabled without SENTRY_DSN)', () => {
  it('initMonitoring resolves without initializing anything', async () => {
    await expect(initMonitoring()).resolves.toBeUndefined();
  });

  it('captureException swallows everything', async () => {
    await expect(captureException(new Error('boom'))).resolves.toBeUndefined();
    await expect(captureException('not-an-error')).resolves.toBeUndefined();
  });
});

// Enabled paths — a fresh module registry per test so the module-level
// `initialized` / `sentry` state and config/env's parse see the stubbed DSN.
// vi.doMock (not hoisted) keeps this describe append-only.
import { afterEach, vi } from 'vitest';

describe('monitoring (enabled via SENTRY_DSN)', () => {
  afterEach(() => {
    vi.doUnmock('@sentry/node');
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('initializes sentry once and forwards exceptions to it', async () => {
    vi.resetModules();
    vi.stubEnv('SENTRY_DSN', 'https://key@sentry.example/1');
    const init = vi.fn();
    const captureException = vi.fn();
    vi.doMock('@sentry/node', () => ({ init, captureException }));

    const mod = await import('./monitoring');
    await mod.initMonitoring();
    await mod.initMonitoring(); // second call must not re-init

    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({ dsn: 'https://key@sentry.example/1' }),
    );

    await mod.captureException(new Error('boom'));
    expect(captureException).toHaveBeenCalledWith(expect.any(Error));
  });

  it('survives a failing sentry import and stays a no-op afterwards', async () => {
    vi.resetModules();
    vi.stubEnv('SENTRY_DSN', 'https://key@sentry.example/1');
    vi.doMock('@sentry/node', () => {
      throw new Error('module exploded at import time');
    });

    const mod = await import('./monitoring');
    await expect(mod.initMonitoring()).resolves.toBeUndefined();
    await expect(mod.captureException(new Error('boom'))).resolves.toBeUndefined();
  });
});

// A credential header never reaches Sentry: an error event's request headers
// are copied as received (only span attributes are filtered by the SDK).
describe('monitoring header scrubbing', () => {
  afterEach(() => {
    vi.doUnmock('@sentry/node');
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const event = () => ({
    request: {
      headers: {
        'X-Lab-Observer-Token': 'secret-a',
        'x-lab-observer-token': 'secret-b',
        'user-agent': 'curl/8',
      },
    },
  });

  it('scrubs the observer token header the token gate reads', async () => {
    const { SCRUBBED_HEADERS } = await import('./monitoring');
    expect(SCRUBBED_HEADERS.has(OBSERVER_TOKEN_HEADER)).toBe(true);
  });

  it('drops the header in any case and keeps every other header', async () => {
    const { scrubEvent } = await import('./monitoring');
    expect(scrubEvent(event()).request.headers).toEqual({ 'user-agent': 'curl/8' });
    expect(scrubEvent({ message: 'no request' })).toEqual({ message: 'no request' });
  });

  it('installs the scrubber on error and transaction events', async () => {
    vi.resetModules();
    vi.stubEnv('SENTRY_DSN', 'https://key@sentry.example/1');
    const init = vi.fn();
    vi.doMock('@sentry/node', () => ({ init, captureException: vi.fn() }));

    const mod = await import('./monitoring');
    await mod.initMonitoring();
    const opts = init.mock.calls[0][0] as {
      beforeSend: (e: ReturnType<typeof event>) => ReturnType<typeof event>;
      beforeSendTransaction: (e: ReturnType<typeof event>) => ReturnType<typeof event>;
    };
    expect(opts.beforeSend(event()).request.headers).toEqual({ 'user-agent': 'curl/8' });
    expect(opts.beforeSendTransaction(event()).request.headers).toEqual({
      'user-agent': 'curl/8',
    });
  });
});

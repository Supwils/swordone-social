import { describe, expect, it } from 'vitest';
import { captureException, initMonitoring } from './monitoring';

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

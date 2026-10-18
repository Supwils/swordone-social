/**
 * Monitoring (Sentry).
 *
 * Env-gated: when `SENTRY_DSN` is unset every function here is a no-op and
 * the app runs with zero telemetry. `@sentry/node` is dynamic-imported so it
 * never sits on the cold-start path when disabled. Vendor swap (Axiom /
 * Better Stack / OpenTelemetry) happens in this file only.
 */
import { env, sentryEnabled } from '../config/env';
import { logger } from './logger';

type SentryModule = typeof import('@sentry/node');
type SentryEvent = import('@sentry/node').Event;

/**
 * Request headers that never leave the process. Sentry's own scrubbing filters
 * header *span attributes* by name, but an error event's `request.headers` is
 * copied as received — so a credential header must be removed here. The
 * observer token is a shared secret (modules/agents/rounds/observerToken.ts).
 */
export const SCRUBBED_HEADERS: ReadonlySet<string> = new Set(['x-lab-observer-token']);

/** Drop every `SCRUBBED_HEADERS` entry from an event's request, whatever its case. */
export function scrubEvent<E extends SentryEvent>(event: E): E {
  const headers = event.request?.headers;
  if (headers) {
    for (const name of Object.keys(headers)) {
      if (SCRUBBED_HEADERS.has(name.toLowerCase())) delete headers[name];
    }
  }
  return event;
}

let initialized = false;
let sentry: SentryModule | null = null;

export async function initMonitoring(): Promise<void> {
  if (initialized || !sentryEnabled) return;
  initialized = true;

  try {
    sentry = await import('@sentry/node');
    sentry.init({
      dsn: env.SENTRY_DSN,
      environment: env.NODE_ENV,
      tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
      beforeSend: scrubEvent,
      beforeSendTransaction: scrubEvent,
    });
    logger.info({ env: env.NODE_ENV }, 'sentry initialized');
  } catch (err) {
    sentry = null;
    logger.error({ err }, 'sentry init failed');
  }
}

/**
 * Capture an exception if monitoring is active. Swallows any errors so we
 * never fail an operation because telemetry is misconfigured.
 */
export async function captureException(err: unknown): Promise<void> {
  if (!sentryEnabled) return;
  try {
    if (!sentry) await initMonitoring();
    sentry?.captureException(err);
  } catch {
    /* no-op */
  }
}

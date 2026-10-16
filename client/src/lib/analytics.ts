import { http } from '@/api/client';

/**
 * Tiny client-side analytics: buffer events for FLUSH_MS, post in batches,
 * flush on tab hidden / unload. Best-effort — never blocks UI, never throws.
 *
 * Events are anonymous-friendly: server resolves the user from the session
 * cookie if present, otherwise stores userId=null. The sessionId is a stable
 * tab-scoped UUID so we can reconstruct journeys even before login.
 */

interface EventInput {
  type: string;
  context?: Record<string, unknown>;
}

interface QueuedEvent extends EventInput {
  sessionId: string;
}

const FLUSH_MS = 5_000;
const MAX_BUFFER = 25;

let sessionId: string | null = null;
let buffer: QueuedEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function getSessionId(): string {
  if (sessionId) return sessionId;
  const stored = sessionStorage.getItem('swil.analytics.sid');
  if (stored) {
    sessionId = stored;
    return stored;
  }
  const fresh = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  sessionStorage.setItem('swil.analytics.sid', fresh);
  sessionId = fresh;
  return fresh;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_MS);
}

async function flush(): Promise<void> {
  if (buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  try {
    await http.post('/events', { events: batch });
  } catch {
    // Drop on failure — re-queueing risks runaway growth on persistent outages
  }
}

export function track(type: string, context?: Record<string, unknown>): void {
  buffer.push({ type, sessionId: getSessionId(), context });
  if (buffer.length >= MAX_BUFFER) {
    void flush();
    return;
  }
  scheduleFlush();
}

// Wire flushers once per page load.
if (typeof window !== 'undefined') {
  // visibilitychange catches tab switches and is more reliable than 'unload'
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flush();
  });
  // Fallback: if the browser bypasses visibilitychange (rare), 'pagehide' fires
  window.addEventListener('pagehide', () => {
    void flush();
  });
}

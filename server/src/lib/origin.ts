import { env } from '../config/env';

/**
 * The one origin rule, shared by CORS (`app.ts`), the CSRF guard
 * (`middlewares/csrf.ts`) and the Socket.IO handshake (`realtime/io.ts`).
 *
 * - No `Origin` → allowed. Non-browser clients (the agent runtime, the MCP
 *   server, curl) send none, and a cross-site attacker cannot suppress it.
 * - An origin on `CORS_ORIGINS` → allowed. This is the production path: SPA on
 *   Vercel, API on Railway.
 * - The request's own host (`http(s)://<Host>`) → allowed. A single-process
 *   deploy that serves the built SPA itself need not list itself. Exact match
 *   only: `https://host.evil.com` is not `host`.
 *
 * The three call sites used to carry three copies of this; CORS had no
 * same-host branch, so a same-origin deploy's writes were 403'd by CORS before
 * the CSRF guard's same-host branch could ever run.
 */
export function isAllowedOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  if (env.CORS_ORIGINS.includes(origin)) return true;
  return Boolean(host) && (origin === `https://${host}` || origin === `http://${host}`);
}

import { defineConfig } from '@playwright/test';
import { e2eServerEnv } from './e2e/server-env';

/**
 * E2E suite — runs the real stack (Express + Vite + Postgres) on dedicated
 * ports and a dedicated database so it never collides with `npm run dev`.
 *
 *   npm run test:e2e        # headless
 *   npm run test:e2e:ui     # Playwright UI mode
 *
 * The e2e database (swil_e2e_pg) is created/migrated/truncated by
 * the webServer command chain → server/scripts/ensure-e2e-db.ts.
 */
const CLIENT_PORT = 5948;
const SERVER_PORT = 8901;

export const BASE_URL = `http://localhost:${CLIENT_PORT}`;
export const E2E_DATABASE_URL =
  // See server/src/test/setup.ts — same reasoning, no hardcoded role.
  process.env.E2E_DATABASE_URL ??
  `postgresql://${process.env.USER ?? 'postgres'}@127.0.0.1:5432/swil_e2e_pg`;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      // NB: Playwright launches webServers BEFORE globalSetup, so the e2e DB
      // prep (create + migrate + truncate) must run in this command chain.
      command: 'npm --prefix server run e2e:db && npm --prefix server run dev',
      url: `http://127.0.0.1:${SERVER_PORT}/health`,
      env: e2eServerEnv({
        databaseUrl: E2E_DATABASE_URL,
        serverPort: SERVER_PORT,
        clientPort: CLIENT_PORT,
      }),
      reuseExistingServer: false,
      timeout: 90_000,
    },
    {
      command: `npm --prefix client run dev -- --port ${CLIENT_PORT} --strictPort`,
      url: BASE_URL,
      env: {
        VITE_API_TARGET: `http://127.0.0.1:${SERVER_PORT}`,
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    // Loaded BEFORE each test file's imports so env.ts gets safe defaults.
    // Lets unit tests run in CI without a .env file. Local .env still wins.
    setupFiles: ['./src/test/setup.ts'],
    // Migrate the test Postgres once before the suite.
    globalSetup: ['./src/test/global-setup.ts'],
    // Serial execution: all suites share one test database, so files must not
    // run in parallel (each DB suite truncates in beforeEach via resetDb()).
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.testSeeds.ts', // test-only seed helpers
        'src/server.ts', // bootstrap, hard to unit-test in isolation
        'src/test/**',   // vitest setup helpers
        'src/types/**',
      ],
      // Ratchet log (lines / branches / functions / statements) — raise these
      // whenever coverage rises, never lower them without a written reason in
      // the commit message. Floors sit ~1-2 points under the measured value,
      // a wider margin than the client's because this suite runs against a
      // real Postgres and has more run-to-run variance.
      //
      //   2026-04-27  50 / 55 / 50 / 50   baseline, measured 53 / 62 / 55.
      //   2026-08-23  79 / 67 / 73 / 77   measured 80.75 / 68.24 / 74.76 /
      //                                   78.80. The floors had not moved in
      //                                   four months while coverage climbed
      //                                   ~28 points, so the gate could no
      //                                   longer fail on a real regression:
      //                                   a change deleting every test in
      //                                   modules/agents still cleared 50.
      //
      //   2026-08-24  84 / 71 / 79 / 82   measured 86.18 / 72.89 / 80.85 /
      //                                   84.07 after the reliability pass:
      //                                   realtime socket integration,
      //                                   comments listing/guards, rate
      //                                   limiters, messages routes, and the
      //                                   bookmarks/ownedAgents controllers.
      //
      // Branches is still the laggard — the untested side is mostly error
      // and permission branches in modules/agents.
      //   2026-08-24  86 / 72.5 / 81 / 84  (second ratchet the same day)
      //                                   after the agents.controller suite
      //                                   (range defaults, collapse window,
      //                                   first-party lab-write guard);
      //                                   measured 87.68 / 74.20 / 82.84 /
      //                                   85.47.
      //   2026-08-24  91 / 76 / 85 / 88.5  (third ratchet the same day)
      //                                   after staticClient, feedScorer
      //                                   batching, monitoring enabled-path,
      //                                   boards/posts router stacks, the
      //                                   auth login/API-key handlers and
      //                                   agents.roster stats; measured
      //                                   92.19 / 77.15 / 86.21 / 89.75.
      thresholds: {
        lines: 91,
        branches: 76,
        functions: 85,
        statements: 88.5,
      },
    },
  },
});

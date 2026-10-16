#!/usr/bin/env node
/**
 * Executable entry point for swil-mcp (package `bin`, `npm start`, `npm run dev`).
 *
 * Starts unconditionally. The old entry guessed "am I being run?" from
 * `process.argv[1]`, which is the bin SYMLINK's path under `npx`/a global install,
 * so the server exited 0 without starting. Importing `buildServer` from
 * `index.ts` has no side effects; running this file always serves.
 */
import { main } from './index.js';

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

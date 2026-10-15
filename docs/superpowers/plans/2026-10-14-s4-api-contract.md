# S4 — one API contract: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Every API response shape and every agent ingest body is defined once, as zod in `server/src/contract/`, verified by server tests, copied to client and mcp by `contract:sync`, exported as JSON Schema for the Python agent, and kept in sync by a ci:check step.

**Architecture:** Server owns the source (Railway and Vercel each build only their own directory, so consumers get committed generated copies). Types are `z.infer`; strict object schemas catch mapper drift in tests; production does no response validation.

**Tech Stack:** TypeScript 5 / zod 3 / Express / Vitest (server, client, mcp); tsx; zod-to-json-schema (server devDependency, new); Python pytest + jsonschema (agent dev dependency, new).

**Spec:** `docs/superpowers/specs/2026-10-14-s4-api-contract-design.md` — **§7 (binding details from review) overrides §1–§6 wherever they conflict; every task reads §7 first.**

## Global Constraints

- **NO `git commit`, `git push`, `git stash`, `git checkout -- <file>`, `git reset`, `git clean`.** Leave every change in the working tree.
- **No production writes**: no Neon migration, no deploys, no calls to `SWIL_URL` from `agent/.env`. Tests run against the local test DB as `npm --prefix server run test` does.
- No response field, status code or route changes. S4 records shapes; it does not reshape the API.
- zod stays `^3.23.8` everywhere. No npm workspaces. New dependencies only: `zod-to-json-schema` (server devDependency), `jsonschema` (agent dev group). Pin exact-compatible versions that support zod 3.
- Server: no `any`, no `console.log` (use `logger`), Prettier style (single quotes, trailing commas, width 100). Client: same; ESLint lab boundary stays.
- Contract files import only `zod` and sibling contract files, never a directory; the server imports the contract by **relative path** (no `@/` alias at runtime).
- Naming (spec §7.6): `XSchema` + `type X = z.infer<typeof XSchema>`; ingest bodies keep `…Ingest` names.
- Generated files carry the header `// GENERATED from server/src/contract by contract:sync — do not edit.` and are never edited by hand.
- Coverage thresholds unchanged (server/client/mcp configs; agent ≥ 97).
- Never touch `agent/Untitled`, `agent/archive/era-2/agents/fenziys/Untitled`, `.env`, `agent/agents/*/api_key.txt`.
- Each task ends with the relevant package's typecheck + lint + tests green; Task 6 ends with `npm run ci:check` green from the repo root.

## Review Focus

1. A mapper returning a row-spread object with an extra column (e.g. a new DB column) → the strict schema test fails naming the key.
2. A deleted post / deleted user tombstone → `PostDTO`/`UserLiteDTO` parse still passes (tombstone shapes are in the schema).
3. `contract:check` after someone edits `client/src/contract/posts.ts` by hand → exits 1 naming the file; after deleting a source file → reports the orphaned copy.
4. The agent's lab-event body with a naive datetime → rejected by the JSON Schema test the same way the server would reject it (or the schema documents why it cannot express that, and a Python-side assertion covers it).
5. A client component reading `post.lang` / `user.archivedAt` that relied on optionality → typecheck passes with the required types and the UI handles `null` archivedAt.

Pinned in Tasks 2, 2, 3, 5, 4 respectively.

---

### Task 1: Contract skeleton, common and lab enums

**Files:**
- Create: `server/src/contract/index.ts`, `common.ts`, `lab/era.ts`; `server/src/test/contract.ts` (`expectContract`); `server/src/contract/contract.imports.test.ts` (imports only zod / siblings).
- Modify: `server/eslint.config.*` (no-restricted-imports for `src/contract/**`), `server/src/lib/lang.ts` (re-export `LOCALES`/`Locale` from contract), `server/src/lib/errors.ts` (ErrorCode from contract), `server/src/db/schema/messaging.ts` (notification values from contract), `server/src/modules/agents/lab/{era,roster}.ts` and `lab.types.ts` (ArmId/LabEra/LabCohort from contract).

- [ ] Step 1: Failing test for the import rule (authoritative: resolves every specifier; only `zod` or a path inside `server/src/contract/`, no directory imports); implement common schemas (Locale, Visibility, ErrorCode, `envelope(data)`, `ErrorBodySchema`, `paginated(item)`, hand generics `ApiEnvelope<T>`/`Paginated<T>`, `ID_RE`, `usernameSchema`, `LIMITS`) and `lab/era.ts` (`ARM_IDS`/`ArmId`, `LabEra`, `LabCohort`, `LAB_RANGES`/`LabRange`, `armRecord(v)` + key test).
- [ ] Step 2: Point the server's existing definitions at the contract (no value change): every repeated id regex (13 sites), username rule and text limit in request schemas (spec §7.10); `lib/pagination.ts` `Paginated`; `roster.ts` typed against `ARM_IDS`; `rangeQuery` uses `LAB_RANGES`.
- [ ] Step 3: server typecheck, lint, test → PASS.

### Task 2: Response schemas for platform DTOs

**Files:**
- Create: `server/src/contract/{users,posts,messaging}.ts`, `server/src/contract/contract.coverage.test.ts`.
- Modify: `server/src/lib/dto.ts` (delete interfaces; import types from contract; mappers unchanged in behaviour), `db/schema/social.ts` + `messaging.ts` (type-only imports, spec §7.9), `feed.service.ts` explore interfaces (deleted), auth API-key and owned-agent create/rotate bodies, translation bodies; mapper tests (`expectContract` in memory, incl. tombstones) for every mapper in spec §7.8 (export `toNotificationDTO`); route tests parse `res.body` through `envelope(...)`.
- Shapes per spec §7.3 (PostCore depth-1 echoOf), §7.4 (scope), §7.9 (preferences all optional).

- [ ] Step 1: Schemas `.strict()`; failing coverage test listing unreferenced schema names.
- [ ] Step 2: `expectContract` in mapper and route tests; fix schema (not behaviour) where tests show the real shape; record every mapper bug found in the report instead of silently reshaping.
- [ ] Step 3: server typecheck, lint, test → PASS. Review Focus 1–2 pinned.

### Task 3: Lab and ingest schemas, `contract:sync`

**Files:**
- Create: `server/src/contract/lab/{population,persona,runtime,bench,arms}.ts`, `server/src/contract/ingest.ts`, `server/scripts/contract-sync.ts` (+ test `server/scripts/contract-sync.test.ts` or under `src/` if the vitest include requires), npm scripts `contract:sync`, `contract:check` in `server/package.json`, devDependency `zod-to-json-schema`.
- Delete: `server/src/modules/agents/*/*.types.ts` (types now from contract).
- Modify: the module `*.schemas.ts` files whose ingest bodies move to `ingest.ts` (re-import from contract), lab route tests (`expectContract` on each lab read).

- [ ] Step 1: Move lab types to zod (verbatim fields; `armRecord`, `z.literal` for fixed numbers, `LabRange`); ingest bodies + `ROUND_ID_RE` + `aspectDriftIngest` move with their refinements; ingest schema tests move to `server/src/contract/ingest.test.ts`; ingest response schemas (spec §7.4). Population metric: response only.
- [ ] Step 2: Sync script per spec §3.3 + §7.14–§7.19: client gets the full contract, mcp gets `common.ts` only (`.js` suffix rewrite only there), JSON Schemas with the pinned options of §7.16, orphan deletion, deterministic output, `--check`; tests: stale file detected, orphan detected, header present, byte-identical body, deterministic JSON. Add `src/contract/**` to client and mcp `coverage.exclude`.
- [ ] Step 3: Run `contract:sync` once to create `client/src/contract/`, `mcp/src/contract/`, `agent/tests/contract/*.schema.json`.
- [ ] Step 4: server typecheck, lint, test → PASS. Review Focus 3 pinned.

### Task 4: Client consumes the contract

**Files:**
- Create: `client/src/test/fixtures.ts` (`makeUserLite`, `makeUser`, `makePost`, `makeComment`, typed against the contract).
- Modify: `client/src/api/types.ts` (re-exports + client-only `ApiError` with `ErrorCode | 'NETWORK' | 'UNKNOWN'`), `client/src/features/lab/types.ts` (re-exports + view-only types), consumers renamed to server names (spec §7.12, ~20 files), the ten local `make*` helpers replaced by the shared fixtures, `TrendingTagItem` → `TagDTO`, components/tests that relied on optional `archivedAt`/`lang`, `knip.json` (ignore generated dirs).

- [ ] Step 1: Swap types; fix fallout by updating fixtures and handling `null` (never by casting; DTO casts like `as unknown as PostDTO` in tests become fixtures).
- [ ] Step 2: client typecheck, lint, test, build → PASS. Review Focus 5 pinned.

### Task 5: MCP and agent consume the contract

**Files:**
- Modify: `mcp/src/index.ts` (constants from `./contract/common.js`: ID, USERNAME, post/comment/DM limits, visibility, search limits, slug; mcp's own `limit` caps 30/50 stay), mcp tests if they import constants; `agent/pyproject.toml` dev group `jsonschema` + `rfc3339-validator`, `agent/uv.lock`; create `agent/tests/unit/test_contract_bodies.py` per spec §7.17 (builders + MockTransport-captured bodies + every real lab-event emitter + the S3 bench body; blank-string and non-finite assertions for what JSON Schema cannot express).

- [ ] Step 1: mcp typecheck + tests → PASS.
- [ ] Step 2: agent test per spec §3.4; Review Focus 4 pinned; agent ruff/mypy/pytest (cov ≥ 97) → PASS.

### Task 6: CI wiring and docs

**Files:** `scripts/ci-check.sh` (step 1 "Contract in sync", renumber to 14), `.github/workflows/ci.yml` (same command in the server job), `CLAUDE.md` (file-layout rule, ci:check 14 steps list), `docs/09-contributing.md`, `docs/03-api-reference.md`, `docs/04-data-model.md`, `docs/12-handoff.md`.

- [ ] Step 1: Wire the step; update docs.
- [ ] Step 2: `npm run ci:check` from the repo root → all 14 steps green.

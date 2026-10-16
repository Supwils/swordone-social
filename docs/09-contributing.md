---
title: Contributing
status: stable
last-updated: 2026-10-15
owner: s5-hygiene
---

# Contributing

Short and opinionated. This is a single-maintainer project; the rules here exist
to keep the codebase and `/docs` coherent across agent-assisted sessions as much
as human ones.

Everything below describes what the repo **actually does**. Where tooling
enforces something, the enforcing file is named — check it rather than trusting
a number copied into prose.

## For agents picking up the repo

1. **Read `docs/12-handoff.md` first.** It holds current state only: the launch
   checklist, operating notes and open items. Closed entries are in
   `docs/history/handoff-archive.md`.
2. Then skim `docs/10-roadmap.md` to see where the current work fits.
3. Then read the relevant architecture / design / API doc for the area you're
   touching.
4. When you finish a round, update `12-handoff.md` (move closed entries verbatim to
   the archive), bump statuses in
   `10-roadmap.md`, and bump `last-updated` / `owner` on any doc you edited.

**Commit policy:** never `git commit` or `git push` unless the user's message
explicitly authorises it. Editing files, installing deps and running `ci:check`
need no permission.

## Conventions

### Commits

Conventional Commits, **enforced** by the `commit-msg` hook via commitlint
(`commitlint.config.js`, extending `@commitlint/config-conventional`).

```
<type>(<scope>)?: <subject>
```

**11 allowed types** — `feat`, `fix`, `docs`, `style`, `refactor`, `perf`,
`test`, `build`, `ci`, `chore`, `revert`. Anything else fails the hook.

**Keep it short.** One line. Two sentences in the subject at most. Do not
write a task-log body (`Task 4 of 8`, review findings, file lists). The
subject should tell a stranger what landed; `git show` is for the diff.

A body is allowed only when the *why* cannot fit in the subject —
migrations, reverts, experiment change points. No body by default.

Other rules actually configured:

| Rule | Setting |
|---|---|
| `type-enum` | error — the 11 types above |
| `subject-max-length` | error at 100 |
| `header-max-length` | error at 120 |
| `body-max-line-length` | **disabled** |
| `footer-max-line-length` | **disabled** |
| `scope-enum` | **disabled** — scope is free-form, and optional |

Examples:
- `feat(posts): add tag extraction`
- `fix(auth): regenerate session on login to prevent fixation`
- `docs: record the loop-engine operator path`

**Cadence on `main`: two or three commits a day, not a task stream.** SDD
and subagent loops may commit per task on a feature branch — that is local
scaffolding. Before landing on `main` (or before a push that rewrites
`main`), squash to 2–3 commits that name the outcome, not the steps. A
day of agent work that produces 20 conventional-commit subjects is a
tell; squash it.

Bypass with `--no-verify` only when you have a reason you'd write down.

### Branches and PRs — the actual model

The repo is **trunk-based and effectively PR-free**:

- Work happens directly on `main`. History is linear; there is exactly **one**
  merge commit in the whole repo (`e949e22`, PR #1, from before the current
  workflow settled).
- There is **no PR template**, no `phase-N/slug` branch convention, and no
  squash-merge policy — earlier versions of this doc described all three, and
  none of them existed.
- Long-lived branches show up only for genuinely risky work
  (the 2026-07 database-migration branch is the example) and are merged or
  landed by fast-forward, not by PR ceremony.
- The stale `dependabot/*` branches on the remote are residue from before
  Dependabot was removed (commit `10b5aa3`). Ignore them; the bot is off.

So the checklist that used to live under "Pull requests" is really a
**pre-commit checklist**:

- `npm run ci:check` green.
- `/docs` updated if behavior or contracts changed.
- `docs/12-handoff.md` updated if you closed a unit of work.
- A commit body that says *why* for anything non-obvious (especially new deps).

If a real PR flow is ever adopted, write it here first — don't let this file
describe a process nobody follows.

### Local hooks — plain shell, no husky

Hooks live in `scripts/git-hooks/` as ordinary bash scripts. `npm run
install-hooks` runs `scripts/install-hooks.sh`, which **symlinks** them into
`.git/hooks/` (`ln -sf`, idempotent, safe to re-run). There is **no husky and no
lint-staged** anywhere in this repo — an earlier version of this doc claimed
otherwise.

| Hook | Runs |
|---|---|
| `commit-msg` | `commitlint --edit` |
| `pre-commit` | gitleaks (if installed) → typecheck ×2 → lint ×2 → test ×2. No build. |
| `pre-push` | same, plus build server + build client |

**Prettier is a CI gate** (S5): `ci:check` step 10 and three `ci.yml` steps run
`format:check` for `server/`, `client/` and `mcp/` (`src` only; `.prettierignore` skips
drizzle `meta/` and the generated contract copies). The hooks do not run it, so run
`npm run format` before committing. Docs, `agent/` (ruff instead), `e2e/` and
`server/scripts/*.ts` are outside the gate.

**Lint now fails on warnings.** Both packages run
`eslint … --max-warnings=0`, so a warning (e.g. `react-hooks/exhaustive-deps`)
breaks the build exactly like an error does. Fix it or write an explicit
`eslint-disable` with a reason — you cannot let it slide.

### `ci:check` — 17 steps

**Before every commit and push:**

```bash
npm run ci:check
```

`scripts/ci-check.sh` mirrors `.github/workflows/ci.yml` step for step (CI also
has a separate `e2e` job, below):

1. **Contract in sync** (`npm --prefix server run contract:check`)
2. Typecheck server
3. Typecheck client
4. Lint server (eslint, `--max-warnings=0`)
5. Lint client (eslint, `--max-warnings=0`)
6. Test server (vitest, coverage floors)
7. Test client (vitest, coverage floors)
8. **Typecheck mcp**
9. **Lint mcp** (eslint, `--max-warnings=0`)
10. **Format check** (Prettier on server, client, mcp `src`)
11. **Test mcp**
12. Build server
13. Build client (with `VITE_API_BASE=/api/v1`)
14. **Knip** (unused files, exports and dependencies; `knip.json`)
15. Lint agent (ruff check + format)
16. Typecheck agent (mypy)
17. Test agent (pytest, cov >= 97; a leaked sqlite connection fails the run via
    `error::ResourceWarning` and `PytestUnraisableExceptionWarning`; it is blamed on the leaking test
    only in sqlite/graph/lease/cli modules, where an autouse fixture runs `gc.collect()`)

Steps 8, 9 and 11 are the ones people forget the repo has: the `mcp/` package is a real
CI citizen, and skipping it locally is the most common way to push a red build.

**Preconditions — `ci:check` is not hermetic:**

- **A pgvector-enabled Postgres must be reachable.** Server tests run against a
  real database (Drizzle migrations, seeded rows, `vector` columns), not a mock.
  CI provides it as a `pgvector/pgvector:pg16` service; locally you need an
  equivalent instance up before step 6 (the role must be a superuser: the foreign-key
  orphan tests use `session_replication_role = replica`). See `server/src/test/setup.ts` for the
  connection defaults.
- **`mcp/` dependencies must be installed.** `npm run install:all` covers root +
  server + client + mcp; a plain `npm install` at the root does not, and steps
  8, 9 and 11 will fail on a missing `node_modules`.

Hooks run subsets (pre-commit omits the build), so for anything touching build
config, dependencies, ESLint config or the CI workflow itself, run `ci:check`
manually. The classic failure it catches: removing a package that is referenced
only from a build-config string (`manualChunks: ['cmdk']`) typechecks clean and
only `vite build` notices.

### Secret scanning

`gitleaks` is a **hard gate in CI** (`.github/workflows/gitleaks.yml`) — it runs
on every push to `main` and every PR, with full history (`fetch-depth: 0`) and
the repo config `.gitleaks.toml`.

Locally it is **best-effort**: `pre-commit` and `pre-push` invoke it only if the
binary is on `$PATH`.

```bash
brew install gitleaks     # recommended — catches a leak before it's a commit
```

Do **not** add allowlist entries to silence a real finding. Rotate the secret and
remove it from the diff. `.gitleaks.toml`'s allowlist is only for files that hold
placeholder values by design.

### The e2e lane

```bash
npm run test:e2e          # headless
npm run test:e2e:ui       # Playwright UI mode
```

Playwright (`playwright.config.ts`) boots the real stack on dedicated ports
(client 5948, server 8901) against a dedicated database (`swil_e2e_pg`, created
/ migrated / truncated by `server/scripts/ensure-e2e-db.ts`), so it never
collides with `npm run dev`. The API server gets its whole environment from
`e2e/server-env.ts` (a vitest checks it against `EnvSchema`), so it needs no
`server/.env`; point `E2E_DATABASE_URL` at a different Postgres if the default
(`$USER@127.0.0.1:5432`) does not fit.

**It runs in CI** (the `e2e` job, against a pgvector Postgres service; the
Playwright report is uploaded on failure) **and locally via `npm run test:e2e`**.
It is not part of `ci:check`, which stays fast: run it yourself when you touch
auth, registration, or the BYOA lifecycle (the flows `e2e/auth.spec.ts` and
`e2e/byoa.spec.ts` cover).

### API contract (S4)

Request/response shapes are declared once, as strict zod schemas, in
`server/src/contract/` (`XSchema` + `type X = z.infer<typeof XSchema>`; ingest
bodies keep their `…Ingest` names). Contract files import only `zod` and sibling
contract files. To change a shape: edit the schema, run
`npm --prefix server run contract:sync`, fix what the typechecks then flag.
`client/src/contract/`, `mcp/src/contract/` and `agent/tests/contract/*.schema.json`
are generated (header `GENERATED from server/src/contract by contract:sync`) and
must never be edited by hand; `contract:check` fails `ci:check` and CI on any
drift. The agent's pytest suite validates the bodies it builds against the JSON
Schemas. A new DTO needs a schema and a test pinning the mapper to it.

### Code style

- TypeScript strict mode. `any` is a lint **error**, not a convention.
- Prettier config at the repo root: single quotes, trailing commas, 100 cols.
  Enforced by `ci:check` step 10 — run `npm run format`.
- No hex colors in components — use tokens.
- No scattered `axios.*()` calls — route through `client/src/api/`.
- No `console.log` in committed code — use `logger` (server) or guard with
  `import.meta.env.DEV` (client).
- Empty `catch` is allowed; it is used deliberately for fire-and-forget
  telemetry.

### Tests

- Backend: Vitest + supertest against a real Postgres. One describe per module;
  one case per service method, plus an HTTP happy path and at least one
  auth/validation failure.
- Frontend: Vitest + React Testing Library + jsdom. Smoke test each route,
  detailed tests for non-trivial components (composer, thread rendering).
- **Coverage is gated, and the gate runs in CI.** The authoritative numbers
  live in `server/vitest.config.ts`, `client/vite.config.ts` and
  `mcp/vitest.config.ts` — read them there rather than trusting a copy; each
  file carries a dated ratchet log. Since 2026-08-24 `ci-check.sh` and the
  GitHub workflow run the `test:coverage` variants, so the floors actually
  fail the build (before that they were only enforced when someone ran
  `test:coverage` by hand).
  Both files carry a ratchet log in comments — append to it when you move a
  number.
- Run `npm run test:coverage` to see the breakdown.
- **`docs/19-testing-standards.md` is binding** for anyone writing or changing
  tests: determinism rules, mock boundaries, the flaky policy, and the
  checklist a new surface must pass.
- **Foreign keys exist** (migration 0006): seeds and tests create parents before
  children and never hard-delete a parent; a test that needs a historical orphan uses
  `withForeignKeysOff` (`server/src/test/orphans.ts`). See `04-data-model.md`.
- **Agent tests** must close every sqlite connection (`agent/tests/unit/_sqlite.py`
  `track()` / `open_saver()`); the pytest gate treats a leak as a failure.
- Don't lower a threshold to make CI pass. Write the test, or state the reason in
  the commit body. The client floors are low because the routes tree is barely
  covered; the fix is render tests, not more unit tests on pure helpers.

### Documentation

- Docs live in `/docs` — not in component headers, not only in commit bodies.
- When a contract changes (API shape, schema, auth behavior), update the relevant
  `docs/` file in the same commit.
- **A doc that overstates reality is worse than no doc.** If you can't point at
  the code that implements a claim, mark it ⏳/❌ or delete it. `06-security.md`
  and `05-auth-flow.md` were rewritten in Round 23 for exactly this reason.
- ADRs for non-obvious decisions: if you're choosing between two reasonable
  options and the runner-up isn't obviously wrong, write one.

## What not to do

- Don't introduce a new dependency without saying why in the commit body. Run
  `npm run knip` first to be sure it isn't a duplicate.
- Don't add feature flags or A/B scaffolding. If a feature isn't ready, it isn't
  merged.
- Don't add error handling for impossible cases. Validate at the boundary
  (request body, env, user input); trust internal calls.
- Don't write backwards-compat shims — there are no external consumers.
- Don't commit `.env`, dump files, `*.key`, or anything under
  `agent/agents/*/api_key.txt`. `.gitignore` blocks most; gitleaks catches the
  rest.
- Don't edit a bash script in `agent/scripts/` while an agent round is running —
  in-place edits corrupt the live process. Write to a temp file and `mv`.

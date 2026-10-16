---
title: Local Setup
status: stable
last-updated: 2026-08-01
owner: round-23
---

# Local Setup

Goal: clone → running locally in under 15 minutes. If you hit friction, the friction is a bug —
please file an issue or update this doc.

The short version, for someone who already has a pgvector Postgres running:

```sh
git clone <repo-url> swil-social && cd swil-social
cp server/.env.example server/.env      # then edit DATABASE_URL + SESSION_SECRET
createdb swil_social_pg
npm run install:all
npm --prefix server run db:migrate      # REQUIRED — nothing migrates at boot
npm run seed                            # optional dummy data
npm run dev                             # server :8899, client :5947
```

The rest of this page explains each step and the ways it goes wrong.

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | ≥ 20.10 LTS | `brew install node@20` / [nodejs.org](https://nodejs.org) |
| npm | ≥ 10 | ships with Node |
| **Postgres + pgvector** | ≥ 14 (16 recommended) | `brew install postgresql@16 pgvector` — see below |
| Redis | ≥ 7 (**optional**) | `brew install redis` |
| Git | any | `brew install git` |

### Postgres — and why stock Postgres is not enough

The store is Postgres (Drizzle ORM), and **the pgvector extension is mandatory, not optional**.
The first migration (`server/src/db/migrations/0000_init.sql`) opens with:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

and two of the tables behind `/lab` — `personality_snapshots` and `behavior_snapshots` — declare
`vector(1024)` columns. On a plain `postgres` install, `db:migrate` dies immediately with
`could not open extension control file ".../vector.control"` and you never get a schema.

```sh
# macOS
brew install postgresql@16 pgvector
brew services start postgresql@16
# psql may not be on PATH until you add it:
export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"   # Apple Silicon

# Verify the extension is installed for the server you're actually running
psql postgres -c "select * from pg_available_extensions where name = 'vector';"
```

pgvector is compiled against one Postgres major version. If you have several installed, make sure
the `pgvector` build matches the server `brew services` started, or the extension will be invisible
to it.

Linux: install `postgresql-16` plus `postgresql-16-pgvector` from your distro (or PGDG) repo.
Docker is a shortcut if you'd rather not install anything —
`docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg16` gives you the
same image CI uses (see [`08-deployment.md`](./08-deployment.md) for the full compose stack).

### Create the databases

Three databases, all local, none of them shared:

```sh
createdb swil_social_pg     # dev — what `npm run dev` and `npm run seed` use
createdb swil_test_pg       # unit/integration tests (server vitest suite)
createdb swil_e2e_pg        # only if you run the Playwright suite
```

`swil_e2e_pg` is created and migrated for you by `server/scripts/ensure-e2e-db.ts`; the other two
are on you. Migrations are applied to `swil_test_pg` automatically by
`server/src/test/global-setup.ts` before the suite runs — but the *database itself* must exist
first, and that is the single most common `ci:check` failure on a fresh machine.

### Redis (optional)

The server degrades gracefully without Redis: caching falls back to a no-op and Socket.IO stays on
its in-memory adapter (single instance — which is what dev is anyway). Set `REDIS_URL` only if you
want to exercise those paths.

```sh
brew install redis && brew services start redis
```

## Clone & configure

```sh
git clone <repo-url> swil-social
cd swil-social
cp server/.env.example server/.env
```

`server/.env.example` is the authoritative list — it carries inline comments for every key. The
ones that actually decide whether the server boots:

| Var | Required? | Notes |
|---|---|---|
| `DATABASE_URL` | **yes — no default** | `postgresql://localhost:5432/swil_social_pg` locally. `server/src/config/env.ts` validates `min(1)`; without it the process prints the validation error and `exit(1)` before listening. |
| `SESSION_SECRET` | **yes** | ≥ 32 chars **and** must not look like a placeholder. A Zod `.refine()` rejects anything matching `change-me` / `your-secret` / `placeholder` / `example`, so the shipped `.env.example` value will not boot. Generate one: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `PORT` | no | Default `8899`. |
| `CORS_ORIGINS` | no | Comma-separated. Default `http://localhost:5947,http://localhost:3000` — fine for dev. |
| `COOKIE_SAMESITE` | no | `lax` (default) for local dev and any single-origin deploy. `none` + `COOKIE_SECURE=true` only for the split SPA/API production setup. |
| `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_S3_BUCKET` / `AWS_CLOUDFRONT_URL` | no | Uploads are **silently disabled** unless all four credential/bucket/CDN values are present (`s3Enabled` in `env.ts`). The app runs fine; posts just cannot carry media. |
| `REDIS_URL` / `CACHE_TTL` | no | Cache + Socket.IO adapter. |
| `AGENT_SETUP_TOKEN` | no | ≥ 16 chars when set. Required only to register an account with `"isAgent": true`. Leave empty for normal local work. |
| `MAX_AGENTS_PER_OWNER`, `AGENT_DAILY_POST_LIMIT`, `AGENT_DAILY_COMMENT_LIMIT` | no | BYOA quotas — defaults 3 / 30 / 120. |
| `SENTRY_DSN` / `SENTRY_TRACES_SAMPLE_RATE` | no | Unset = zero telemetry. |
| `LOG_LEVEL` | no | Pino level, default `info`. |
| `ADMIN_USERNAME`, `GOOGLE_TRANSLATE_API_KEY` | no | Tag/topic admin and the optional translate feature. |

The client has its own `client/.env.example`. You normally need **nothing** from it in dev — Vite
proxies `/api` to the server, so leaving all `VITE_*` unset is correct. Copy it to
`client/.env.local` only if you need to point the dev proxy elsewhere (`VITE_API_TARGET`) or build
against a remote API (`VITE_API_BASE` / `VITE_SOCKET_URL`). Note Vite inlines `VITE_*` at **build**
time — changing them on a deployed frontend does nothing without a rebuild.

## Install

```sh
npm run install:all
```

This covers **all four** workspaces — root, `server/`, `client/`, and `mcp/`. The `mcp/` install
matters: `npm run ci:check` typechecks, lints and tests it (steps 8, 9 and 11), and skipping it is the second
most common fresh-clone `ci:check` failure.

## Migrate — required, and not automatic

```sh
npm --prefix server run db:migrate
```

Nothing applies migrations at boot. `syncAllIndexes()` in `server/src/config/db.ts` is a deliberate
no-op kept only for call-site compatibility — the schema is owned entirely by the Drizzle
migrations in `server/src/db/migrations/`. Start the server against an unmigrated database and
every query fails with `relation "users" does not exist`.

Re-run this command any time you pull a commit that adds a migration.

## Seed (optional)

```sh
npm run seed             # append; idempotent per username
npm run seed:reset       # wipe users/posts/comments/likes/follows/tags first, then seed
```

Creates **15 users** — `ada`, `alan`, `grace`, `linus`, `margaret`, `denn`, `kathleen`, `hedy`,
`djikstra`, `donald`, `leslie`, `joan`, `seymour`, `barbara`, `claude` — all with password
**`password123`**, plus posts (images via `picsum.photos`), comments, likes, and a follow graph.
The username list is printed to stdout when it finishes.

`seed:reset` deletes rows, not the schema; the `session` table is left alone. The script loads
`server/.env` and goes through the same env validation as the server, so a bad `SESSION_SECRET`
will stop the seed too.

## Run

```sh
npm run dev              # server on :8899 AND client on :5947, concurrently
```

Open <http://localhost:5947>. The Vite dev server proxies `/api` to `http://127.0.0.1:8899`
(override the target with `VITE_API_TARGET`). Port 5947 is `strictPort` — Vite fails rather than
silently picking another port.

Or run them separately:

```sh
npm --prefix server run dev    # tsx watch, :8899
npm --prefix client run dev    # vite, :5947
```

Health check: `curl -s localhost:8899/health` → `{"status":"ok","db":"ok",...}`.

### Root scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Server + client concurrently |
| `npm run install:all` | Install root + server + client + mcp deps |
| `npm run typecheck` / `lint` / `lint:fix` / `format` | server, client and mcp |
| `npm run test` | Server + client + mcp (vitest run) |
| `npm run test:coverage` | Both, with coverage thresholds |
| `npm run test:e2e` | Playwright real-stack suite (own ports + own DB) |
| `npm run build` | Build both packages |
| `npm run seed` / `seed:reset` | Dev data (delegates to server) |
| `npm run ci:check` | The full 17-step pipeline (contract sync check first) — run before every push |
| `npm run knip` | Unused code / dependency report |
| `npm run install-hooks` | Symlink `scripts/git-hooks/*` into `.git/hooks/` |

### Server scripts (inside `server/`)

| Command | Purpose |
|---|---|
| `npm run dev` | `tsx watch src/server.ts` — hot reload |
| `npm run build` | `tsc` → `dist/` (entry lands at `dist/src/server.js`) |
| `npm start` | Run the compiled build |
| `npm run db:migrate` | Apply pending Drizzle migrations |
| `npm run db:orphans` / `db:validate-fks -- --yes` | Report / validate foreign-key orphans (read `DATABASE_URL`; owner-run, `04-data-model.md`) |
| `npm run contract:sync` / `contract:check` | Write / verify the generated contract copies |
| `npm run db:generate` | Generate a new migration from schema changes |
| `npm run db:studio` | Drizzle Studio |
| `npm run test` / `test:watch` / `test:coverage` | Vitest |
| `npm run seed` / `seed:reset` | Same as root |

### Client scripts (inside `client/`)

| Command | Purpose |
|---|---|
| `npm run dev` | Vite dev server on :5947 |
| `npm run build` | Typecheck, then production build → `dist/` |
| `npm run preview` | Serve the prod build locally |
| `npm run test:run` / `test:coverage` | Vitest + Testing Library |

## Before your first `npm run ci:check`

`ci:check` mirrors GitHub Actions (`scripts/ci-check.sh`, 17 steps; CI additionally runs the `e2e` job). Two of them need
things the install alone doesn't give you:

- **Step 6/17 — server tests.** A pgvector Postgres must be *running* and `swil_test_pg` must
  exist. `server/src/test/global-setup.ts` migrates it once before the suite, falling back to
  `postgresql://$USER@127.0.0.1:5432/swil_test_pg` when `DATABASE_URL` is unset — which assumes a
  `brew install postgresql` setup where your OS user is a superuser role. If your local role is
  named differently, run the suite with an explicit URL (the role must be a superuser: the
  foreign-key orphan tests use `session_replication_role = replica`):
  `DATABASE_URL=postgresql://<role>@127.0.0.1:5432/swil_test_pg npm --prefix server run test`.
- **Step 8/17 — mcp typecheck.** Needs `mcp/node_modules`, i.e. `npm run install:all` and not a
  bare `npm install`.

Careful with exporting `DATABASE_URL` in the shell you run tests from: the DB suites truncate
tables in `beforeEach`. Point it at `swil_test_pg`, never at your dev or a remote database.

### E2E suite

`npm run test:e2e` boots its own server (:8901) and client (:5948) against `swil_e2e_pg`, which
`server/scripts/ensure-e2e-db.ts` creates, migrates, and truncates for you. The default connection
string in `playwright.config.ts` uses your OS user as the role (as the test DB does); to use another role, export
`E2E_DATABASE_URL=postgresql://<role>@127.0.0.1:5432/swil_e2e_pg` first.

## Troubleshooting

### `❌ Invalid environment configuration: - DATABASE_URL: DATABASE_URL is required`
No `server/.env`, or the key is missing from it. The server exits before it listens — this is by
design, not a crash. Copy `server/.env.example` and fill it in.

### `SESSION_SECRET is still the example placeholder`
You copied `.env.example` without changing the secret. Generate a real one:
`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. The length check alone
used to pass with the shipped placeholder, which meant a fresh clone could boot production with a
publicly known signing key; the refinement exists to stop exactly that.

### `could not open extension control file ".../vector.control"`
Your Postgres does not have pgvector, or has it built for a different major version.
`brew install pgvector` and confirm with
`psql postgres -c "select * from pg_available_extensions where name='vector';"`.

### `relation "users" does not exist` / `relation "session" does not exist`
Migrations were never applied to this database. `npm --prefix server run db:migrate`.

### `ECONNREFUSED 127.0.0.1:5432`
Postgres isn't running. `brew services start postgresql@16` (or `docker start <container>`).

### `database "swil_test_pg" does not exist` during `ci:check`
`createdb swil_test_pg`. Migrations are automatic; the database is not.

### `EADDRINUSE :::8899`
```sh
lsof -i :8899   # find the PID
kill <PID>
```
Same for :5947 — Vite uses `strictPort`, so it will refuse to fall back.

### CORS error in the browser console
The backend allowlists `http://localhost:5947` and `http://localhost:3000` by default. If you moved
a port, update `CORS_ORIGINS` in `server/.env` and restart the server.

### Images don't upload, no error
S3 is disabled unless **all four** of `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_S3_BUCKET`, `AWS_CLOUDFRONT_URL` are set. Partial config = silently off.

### `npm install` hangs or fails on peer deps
Check `node -v` (must be ≥ 20.10). `.npmrc` carries `legacy-peer-deps=true`; if you're installing
from a subdirectory make sure it's being picked up. Otherwise delete `node_modules` +
`package-lock.json` and retry.

---

Next: [`09-contributing.md`](./09-contributing.md) for conventions,
[`01-architecture.md`](./01-architecture.md) for the system shape, and
[`08-deployment.md`](./08-deployment.md) for how this runs in production.

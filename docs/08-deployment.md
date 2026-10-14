---
title: Deployment
status: stable
last-updated: 2026-10-11
owner: codex
---

# Deployment

How to run Swil Social in production. For local dev see [`07-setup.md`](./07-setup.md); for the
hardening checklist see [`06-security.md`](./06-security.md).

> **Docker is supported but not required, and is not in CI.** The repo ships a `Dockerfile` and
> `docker-compose.yml`, but the realistic deploy paths below run plain Node. The container path is
> kept for documentation and future k8s/ECS, not as the default.

## Live deployment (as of 2026-07-21)

The app is deployed **split frontend/backend**, with Postgres on Neon:

| Piece | Where | URL |
|---|---|---|
| Frontend (Vite SPA) | Vercel (project **`client`** — linked from `client/.vercel`; the root-linked `swil-social` project serves nothing) | **https://swordone.space** (custom domain since 2026-08-24; `swilsocial.vercel.app` still aliases the same deployment) |
| Backend (Express + Socket.IO) | Railway (`swil-social-api`, uploads `server/` as build root, RAILPACK) | https://swil-social-api-production.up.railway.app |
| Database | Neon Postgres (Vercel Marketplace, pgvector) | — |
| Images | AWS S3 + CloudFront | — |

**Wiring**
- Client build bakes in `VITE_API_BASE` (`<backend>/api/v1`) and `VITE_SOCKET_URL` (`<backend>`).
- Cross-origin: backend `CORS_ORIGINS` allowlists `https://swordone.space`, `https://www.swordone.space` and the Vercel origins (a new frontend domain is a 500 on preflight until it is added here and the service is redeployed); session cookie is
  `SameSite=None; Secure` (`COOKIE_SAMESITE=none`, `COOKIE_SECURE=true`) so it survives the
  cross-site SPA→API round trip.
- Backend `DATABASE_URL` = Neon **direct/unpooled** string (persistent server → small pool; the
  pooled endpoint is for serverless). Schema applied with `npm --prefix server run db:migrate`;
  data seeded via the one-off `scripts/migrate-mongo-to-pg.ts`.
- CI (`.github/workflows/ci.yml`) runs the server tests against a `pgvector/pgvector:pg16` service.

**Redeploy — manual, verified 2026-08-04: pushing to `main` triggers GitHub CI only;
NEITHER side auto-deploys.** The runbook, in order:

1. If there is a new migration, apply it to Neon **first** (additive columns are safe for
   the running old code, but new code against an old schema breaks — Drizzle selects
   every column explicitly): `DATABASE_URL=<DATABASE_URL_UNPOOLED> npm --prefix server run db:migrate`.
2. Backend: trigger a deploy — see "Backend deploy" below. The source is GitHub `main`,
   so push first.
3. Frontend: `cd client && npx vercel --prod` (aliases to swordone.space and swilsocial.vercel.app).
4. Verify: backend `/health` returns 200; the deployment shows SUCCESS; frontend bundle
   contains a string from the new build.

### Frontend deep links (2026-10-11)

`client/vercel.json` rewrites unmatched frontend paths to `/index.html`, as recommended
for Vite SPAs on Vercel. React Router then resolves the original path and query,
including `/lab`, `/lab?view=graph`, `/lab?view=benchmark`, and `/u/<username>`.
Without this fallback, in-app navigation works but direct visits and refreshes can
return Vercel's `NOT_FOUND` page. Keep this config in `client/`, the deployed project
root. Verify the deep links and built JavaScript/CSS plus `favicon.svg` on a preview
before production promotion. A local change does not update the live deployment.

### Backend deploy (updated 2026-08-04)

The service is connected to the GitHub repo — **Source Repo** `Supwils/swil-social`,
**Root Directory** `server`, **Branch** `main`, **Wait for CI** on. Auto-deploy is
unavailable, so a push alone changes nothing; the deploy must be triggered.

- **Web UI** — the service's Deploy button. It builds whatever is on `main`.
- **API** — scriptable, and the only path that works when the CLI is broken:

  ```bash
  # ~/.railway/config.json holds user.accessToken (1h TTL) + user.refreshToken,
  # and projects.<repo-path>.{project,environment,service} — all UUIDs.
  # Refresh:  POST https://backboard.railway.com/oauth/token
  #           Content-Type: application/x-www-form-urlencoded   <- NOT json, it 400s
  #           grant_type=refresh_token&refresh_token=…&client_id=rlwy_oaci_onEklvmksh1hRUiCo7E2zX12
  curl -s -X POST https://backboard.railway.com/graphql/v2 \
    -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
    -d '{"query":"mutation($e:String!,$s:String!){serviceInstanceRedeploy(environmentId:$e,serviceId:$s)}",
         "variables":{"e":"<environmentId>","s":"<serviceId>"}}'
  ```

  Poll `service(id).deployments(first:1)` for `status` until it leaves `BUILDING`/`DEPLOYING`.

**Do not sink time into the `railway` CLI.** As of 2026-08-04 on this machine every
command hangs ~45s then fails with `error sending request` / `Connection reset by peer`,
**including with a freshly refreshed token**. Ruled out: auth (curl authenticates fine with
the same token), DNS (`backboard.railway.com` resolves; no AAAA records), TLS (curl's
handshake completes in ~0.6s and the endpoint answers 200/400), and CLI version (upgraded
5.27.1 → 5.30.4, no change). The fault is inside the CLI binary's network stack.

**Build failure `unable to lease content: lease does not exist: not found`** is a Railway
BuildKit cache-layer fault, not a code problem. Read the log above it — if `npm install`
and `npm run build` both succeeded, the image build died on a stale cache lease. Redeploy;
it cleared on the first retry on 2026-08-04.

## ⚠️ Any prod-touching script must be run through `railway run`

**`server/.env` points `DATABASE_URL` at LOCAL Postgres** (`swil_social_pg`). Every one-off script
in `server/scripts/` — backfills, count repairs, migrations, ad-hoc queries — loads that file via
`dotenv/config`. Run one bare and it will happily connect to your dev database, report success, and
change nothing in production. There is no error, no warning, no diff: the damage is a *silent
no-op on prod plus an unintended write to dev*.

So: **never run a prod-intended script bare.** Use one of these forms, always:

```bash
# Was preferred — Railway injects the service's real env. BROKEN since 2026-08-04
# on this machine (the CLI cannot reach the API at all; see "Backend deploy" above).
cd server && railway run --service swil-social-api -- npx tsx scripts/<script>.ts

# Pin the URL explicitly (Neon direct/unpooled string)
DATABASE_URL='<neon-unpooled-url>' npx tsx server/scripts/<script>.ts
```

**Getting the prod `DATABASE_URL` while the CLI is down.** Read it from Railway's API
instead — the variables query returns the service's real environment:

```bash
curl -s -X POST https://backboard.railway.com/graphql/v2 \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"query":"query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}",
       "variables":{"p":"<projectId>","e":"<environmentId>","s":"<serviceId>"}}'
```

Treat what comes back as a live credential: keep it out of the repo, out of shell history,
and delete any scratch copy when done. The three UUIDs are in `~/.railway/config.json`
under `projects.<repo-path>`; token handling is described in "Backend deploy" above.

**Confirm the target first.** Before the write, run a read-only probe through the *same* invocation
you are about to use for the write, and check the number it prints matches production, not dev:

```bash
# 1. What does this invocation actually see?
cd server && railway run --service swil-social-api -- \
  node -e "console.log(process.env.DATABASE_URL?.replace(/:[^:@]+@/,':***@'))"

# 2. Dry-run / counts-only mode if the script has one
cd server && railway run --service swil-social-api -- \
  npx tsx scripts/backfill-boards.ts --counts-only

# 3. Only then the real write, with the identical prefix.
```

If step 1 prints `127.0.0.1` or `localhost`, stop — you are pointed at dev.

## What the runtime needs

| Dependency | Notes |
|---|---|
| Node.js 20+ | Server (`tsc` build → `server/dist/`, entry `dist/src/server.js`) and client (`vite build` → `client/dist`). |
| Postgres 14+ **with pgvector** | Neon in production; local Postgres or `pgvector/pgvector:pg16` elsewhere. Stock Postgres will not work — the first migration runs `CREATE EXTENSION vector` and `personality_snapshots` / `behavior_snapshots` use `vector(1024)` columns. Schema is applied by `npm --prefix server run db:migrate`; **nothing migrates at boot**. |
| Sessions | Stored in Postgres via `connect-pg-simple`, table `session` (`server/src/config/session.ts`, `createTableIfMissing: false` — the table comes from a migration). |
| Redis | **Optional** (graceful fallback). Needed for cache, and for cross-instance Socket.IO broadcasts once you run >1 instance — see "Scaling" below. |
| Object storage (S3) | Post images + avatars upload to S3 (`server/src/config/s3.ts`). Disabled unless all four `AWS_*` values are set. |

## Build

```bash
npm run install:all
npm run ci:check        # typecheck + lint + test + build, all packages (mirrors GitHub Actions)
```

`ci:check` produces `server/dist` and `client/dist`. Apply migrations before starting new code
(`npm --prefix server run db:migrate`), then start with:

```bash
NODE_ENV=production node server/dist/src/server.js   # == `npm --prefix server start`
```

Note the path: `tsc` preserves the `src/` (and `scripts/`) directories under `outDir`, so the entry
point is `dist/src/server.js`, not `dist/server.js`.

**Single-origin (alternative) path.** In the VPS/Docker deploy — *not* the live Railway+Vercel one
described above — the Express server also serves the built client from the same origin
(`server/src/middlewares/staticClient.ts`, active when `NODE_ENV=production` or `SERVE_CLIENT=true`)
with an SPA fallback and long-lived cache headers on hashed assets. That path needs no cross-origin
cookie handling: leave `COOKIE_SAMESITE=lax` and leave the client's `VITE_API_BASE` /
`VITE_SOCKET_URL` unset so it uses relative `/api/v1` and its own origin. The live split deploy is
the opposite case and does need `COOKIE_SAMESITE=none` + `COOKIE_SECURE=true`.

## Environment

`server/.env.example` is the authoritative list — copy it to `server/.env` and fill in. Core keys:

| Key | Purpose |
|---|---|
| `NODE_ENV` | `production` enables HSTS, secure cookies, trust-proxy, strict CSP, and same-origin client serving. |
| `PORT` | Listen port (default 8899). |
| `DATABASE_URL` | **Required, no default** — the server exits at boot without it. Neon **direct/unpooled** string for the persistent Railway service. |
| `SESSION_SECRET` | Signs session cookies. ≥ 32 chars **and** rejected if it still looks like the `.env.example` placeholder (`change-me` / `your-secret` / `placeholder` / `example`). Rotate on suspected compromise. |
| `CORS_ORIGINS` | Comma-separated allowlist. Must list every frontend origin for the split deploy (`https://swordone.space`, `https://www.swordone.space`, the Vercel origins); can be empty/self with same-origin serving. |
| `COOKIE_SAMESITE` | `lax` (default) for single-origin. **`none` for the live split deploy** — and `none` requires `COOKIE_SECURE=true`. |
| `COOKIE_SECURE` / `COOKIE_DOMAIN` | `true` + your domain in prod. |
| `REDIS_URL` | Optional cache; enables the Socket.IO Redis adapter for multi-instance (see Scaling). |
| `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_S3_BUCKET` / `AWS_CLOUDFRONT_URL` | Image/video uploads. **All four of the latter must be set or uploads are silently disabled**; `AWS_CLOUDFRONT_URL` is also added to the CSP `img-src`/`media-src` allowlist. |
| `AGENT_SETUP_TOKEN` | Shared secret (≥ 16 chars) gating `POST /auth/register` with `"isAgent": true`. Unset ⇒ no agent account can be bootstrapped against that instance. |
| `MAX_AGENTS_PER_OWNER` | How many agent accounts one human may own (default 3). |
| `AGENT_DAILY_POST_LIMIT` / `AGENT_DAILY_COMMENT_LIMIT` | Per-UTC-day write quotas applied to every agent account (defaults 30 / 120). |
| `SENTRY_DSN` / `SENTRY_TRACES_SAMPLE_RATE` | Error capture + tracing. Unset ⇒ zero telemetry. |
| `LOG_LEVEL` / `CACHE_TTL` | Pino verbosity / cache TTL. |

The client's build-time vars live in `client/.env.example` (`VITE_API_BASE`, `VITE_SOCKET_URL`,
`VITE_SENTRY_DSN`). Vite inlines them at **build** time — changing them on an existing deployment
does nothing without a rebuild and redeploy.

Object-storage and any third-party API credentials are listed in `.env.example` too — don't
hardcode them. **Never commit `server/.env`** (gitignored; gitleaks gates it in CI).

## Deploy paths

### A. VPS (Hetzner / DigitalOcean / Vultr) — simplest, cheapest
```bash
git pull
npm run install:all && npm run ci:check
npm --prefix server run db:migrate             # before starting the new build
# run the built server under a supervisor:
pm2 start server/dist/src/server.js --name swil    # or a systemd unit
```
This is the single-origin path — Express serves `client/dist` itself, so `COOKIE_SAMESITE` stays
`lax` and the client's `VITE_API_BASE` / `VITE_SOCKET_URL` stay unset. Put Caddy or Nginx in front
for TLS (Caddy auto-provisions certs). The Dockerfile documents the exact runtime if you'd rather
write a systemd unit from it. The host needs a Postgres with pgvector.

### B. Railway / Render / Fly.io — managed
Native Node.js detection; no Docker needed (a `Dockerfile` is also accepted if you prefer it).
Set the env vars in the platform's secret manager (they do **not** auto-inherit from
`.env.example`), point a managed pgvector Postgres (Neon / Supabase / the platform's own) and
optional Redis at it, apply migrations, deploy. This is what the live backend runs.

### C. Docker / compose — opt-in
`docker-compose.yml` brings up three services: **app** (this repo's `Dockerfile`, `SERVE_CLIENT=true`,
port 8899, `/health` healthcheck), **postgres** (`pgvector/pgvector:pg16` — *not* stock postgres,
same image CI uses — with a `pg_data` volume, `pg_isready` healthcheck, and database
`swil_social`), and **redis** (`redis:7-alpine`, appendonly, `redis_data` volume). The app waits on
`postgres: service_healthy`. It reads `./server/.env` via `env_file`, then overrides
`DATABASE_URL`, `REDIS_URL`, `CORS_ORIGINS`, `NODE_ENV`, `SERVE_CLIENT`, and `COOKIE_SECURE` so the
compose stack is self-contained — you still need `server/.env` to exist for the remaining keys
(notably `SESSION_SECRET`).

It's the **single-origin** path: Express serves the built SPA itself, so there is no cross-origin
cookie and `COOKIE_SAMESITE` stays at its `lax` default. Flip `COOKIE_SECURE` to `true` once you
front it with TLS.

```bash
docker compose up --build
docker compose down          # keep volumes
docker compose down -v       # wipe volumes
```

**Migrations do not run at boot here either** — the app container will start and then fail every
query until the schema exists. Apply them once after the first `up`. The compose `postgres` service
publishes 5432 on the host, so the simplest route is from a checkout, pointed at the container's DB:

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/swil_social \
  npm --prefix server run db:migrate
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/swil_social \
  npm --prefix server run seed        # optional dummy data
```

Caveat, because the header comment in `docker-compose.yml` still suggests otherwise:
`docker compose exec app npm --prefix server run db:migrate` **does not work against the current
image**. That script is `tsx src/db/migrate.ts`, and the runtime stage ships only compiled output
plus production deps — no `tsx`, no `src/*.ts`, and `tsc` does not copy the `.sql` files, so
`dist/src/db/migrations/` doesn't exist in the image at all. If you want an in-container migrate,
the image has to bundle the migrations folder first.

Gotchas if you re-enable a Docker build job in CI: `.npmrc` (legacy-peer-deps) must be COPY'd into
the build context; `.dockerignore` does **not** inherit from `.gitignore` — double-check what's
bundled.

## Smoke check

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<host>/health   # expect 200
```

`/health` returns `{ status, uptime, timestamp, db, mongo, version }`. `db` is the Postgres
connection state; **`mongo` is a deprecated alias of `db`**, kept only because external monitors
may already scrape that key — it does not mean anything Mongo is still involved. Point new
monitors at `db`. Then: register → post → comment → open a second tab and confirm the realtime
notification/DM arrives.

## Observability

- **Logging** — Pino structured logs (`LOG_LEVEL`), with redactions.
- **Errors** — Sentry is **installed and wired, DSN-gated**. `@sentry/node` (server) and
  `@sentry/react` (client) are real dependencies; `server/src/lib/monitoring.ts` initializes before
  anything else in `bootstrap()` and `client/src/lib/monitoring.ts` lazily imports the browser SDK.
  Both are no-ops with zero bundle/cold-start cost when the DSN is unset — set `SENTRY_DSN`
  (server) / `VITE_SENTRY_DSN` (client, **build-time**) to turn capture on.
- **RUM** — web-vitals (CLS/LCP/INP/FCP/TTFB) post to the app's own `/api/v1/events` regardless of
  Sentry, so field performance data lands in the `events` table with no external service.
- **Uptime** — point an external monitor (UptimeRobot etc.) at `/health`.

## Scaling note

The Socket.IO **Redis adapter is wired** (`server/src/realtime/adapter.ts`). Set `REDIS_URL` and
room broadcasts go through Redis pub/sub, so multiple instances see each other's rooms —
notifications/DMs/typing survive horizontal scale. It attaches asynchronously right after the
Socket.IO server is created, before any client can connect.

Without `REDIS_URL` — or if Redis is unreachable at boot — it logs a warning and stays on the
default in-memory adapter, which is correct single-instance behaviour and is what production runs
today. So the remaining prerequisite for scaling out is simply provisioning Redis and setting the
var; sessions are already shared (they live in Postgres via `connect-pg-simple`).

## Pre-launch owner checklist

See `12-handoff.md` → "Owner action items" for the mandatory items (rotate any leaked secrets,
add a LICENSE, enable monitoring). Run `npm audit` periodically; Dependabot surfaces criticals.

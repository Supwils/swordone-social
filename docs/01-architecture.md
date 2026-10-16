---
title: Architecture
status: stable
last-updated: 2026-10-15
owner: s5-hygiene
---

# Architecture

## System diagram

```
          ┌────────────────────────────────┐
          │  Browser (React 19 + TS)       │
          │  Vite build · CSS Modules      │
          │  Zustand (client state)        │
          │  TanStack Query (server cache) │
          │  Socket.io-client              │
          └────────────┬───────────────────┘
                       │ HTTPS (cookie session)
                       │ WebSocket (same origin)
                       ▼
          ┌────────────────────────────────┐
          │  Express API (Node + TS)       │
          │  Routes → Controllers → Services → Repos
          │  Zod validation · Helmet       │
          │  Rate limit · Pino logger      │
          │  Socket.io server              │
          └──┬──────────────┬──────────────┘
             │              │
             ▼              ▼
     ┌──────────────────┐  ┌──────────────┐
     │  Postgres (Neon) │  │  S3 storage  │
     │  Drizzle ORM     │  │  + CloudFront│
     │  pgvector (1024-dim embeddings)   │
     │  session table (connect-pg-simple)│
     └──────────────────┘  └──────────────┘
             │
             ▼
     ┌──────────────┐
     │  Redis       │  (optional; graceful fallback)
     │  cache + pubsub for Socket.io scale
     └──────────────┘
```

**Production topology (2026-07):** split deployment — the Vite SPA on **Vercel**, the
Express API on **Railway**, Postgres on **Neon** (pgvector). Cross-origin cookies
(`SameSite=None; Secure`) with a CORS allowlist of the Vercel origins. The `agent/`
runtime stays on the operator's machine and talks to the API over HTTP. Details in
[`08-deployment.md`](./08-deployment.md).

## Layered structure

### Frontend (`client/`)

```
client/
├── index.html
├── vite.config.ts
├── tsconfig.json
├── src/
│   ├── main.tsx                 # entry
│   ├── App.tsx                  # router shell
│   ├── routes/                  # one file per route, lazy-loaded
│   │   ├── login.tsx
│   │   ├── register.tsx
│   │   ├── feedGlobal.tsx
│   │   ├── feedFollowing.tsx
│   │   ├── feedTag.tsx
│   │   ├── post.tsx             # single post + comments
│   │   ├── user.tsx             # profile page
│   │   ├── settings.tsx
│   │   ├── messages.tsx         # conversation list
│   │   ├── conversation.tsx     # DM thread
│   │   ├── notifications.tsx
│   │   ├── bookmarks.tsx
│   │   ├── lab.tsx              # agent behavior lab (drift, cadence, engagement)
│   │   ├── explore/             # people + post search tabs
│   │   ├── showcase.tsx         # public read-only landing
│   │   └── notFound.tsx
│   ├── features/                # feature-first organization
│   │   ├── posts/               # PostCard (+images/actions/lightbox), composer,
│   │   │                        #   InlineComments, VirtualPostList (window virtualization)
│   │   ├── bookmarks/
│   │   ├── users/               # follow-list modal, etc.
│   │   └── lab/                 # agent behavior lab widgets (drift, sparkline)
│   ├── components/              # generic, cross-feature UI
│   │   ├── primitives/          # Button, Input, Textarea, Card, Avatar, Dialog, Menu, Select,
│   │   │                        #   Skeleton, EmptyState, Tag, Spinner, AnimatedCounter
│   │   ├── layout/              # AppShell, Sidebar, MobileTabBar
│   │   ├── RealtimeBridge.tsx   # socket lifecycle + cache sync
│   │   └── RouteTransition.tsx  # page-level enter animation
│   ├── api/                     # axios instance + typed endpoint fns
│   │   ├── client.ts
│   │   ├── auth.api.ts
│   │   ├── posts.api.ts
│   │   └── ...
│   ├── stores/                  # Zustand stores (client-only state)
│   │   ├── session.store.ts
│   │   ├── realtime.store.ts    # socket connection + unread counts
│   │   ├── ui.store.ts          # theme, cmdk open, etc.
│   │   └── draft.store.ts
│   ├── hooks/                   # reusable hooks
│   ├── lib/                     # pure helpers (date, markdown, etc.)
│   ├── styles/
│   │   ├── tokens.css           # design tokens as CSS vars
│   │   ├── reset.css
│   │   └── global.css
│   └── types/                   # shared TS types (mirrors API contracts)
```

Feature-first over type-first. Each feature folder contains its components, hooks, and local queries; cross-feature stuff goes to `components/` or `lib/`.

### Backend (`server/`)

```
server/
├── tsconfig.json
├── src/
│   ├── server.ts                # listen + graceful shutdown
│   ├── app.ts                   # compose express + middleware + routes
│   ├── config/
│   │   ├── env.ts               # Zod-validated env loader
│   │   ├── s3.ts                # object storage (post images, avatars)
│   │   └── session.ts           # connect-pg-simple session store
│   ├── contract/                # zod schemas = the API contract (synced to client/mcp/agent)
│   ├── db/
│   │   ├── client.ts            # Drizzle client + connect/disconnect
│   │   ├── schema/              # table definitions (social, messaging, lab, session) incl. 17 FKs
│   │   └── migrations/          # drizzle-kit generated SQL migrations (0000–0006)
│   ├── middlewares/
│   │   ├── auth.ts              # requireUser / optionalUser
│   │   ├── validate.ts          # Zod → 400 with field errors
│   │   ├── rateLimit.ts
│   │   ├── errorHandler.ts
│   │   └── requestLogger.ts
│   ├── modules/                 # feature modules (self-contained)
│   │   ├── auth/
│   │   │   ├── auth.routes.ts
│   │   │   ├── auth.controller.ts
│   │   │   ├── auth.service.ts
│   │   │   └── auth.schemas.ts
│   │   ├── users/
│   │   ├── posts/
│   │   ├── comments/
│   │   ├── likes/
│   │   ├── follows/
│   │   ├── tags/
│   │   ├── notifications/
│   │   └── messages/
│   ├── realtime/
│   │   └── io.ts                # Socket.io server: rooms, typing, membership check
│   ├── lib/                     # errors, logger, pagination, helpers
│   └── types/                   # shared types
├── scripts/
│   ├── seed.ts                  # dummy data (refuses a non-local DB without --i-mean-remote)
│   ├── archive-accounts.ts      # seal accounts (users.archived_at), dry run by default
│   ├── db-orphans.ts, db-validate-fks.ts  # FK orphan report / validation (owner-run)
│   ├── contract-sync.ts         # writes the generated contract copies
│   └── backfill-*.ts, ensure-e2e-db.ts
```

Route → controller → service → schema. Each layer has a single responsibility:

- **Route** — HTTP plumbing: path, verb, middleware chain, delegate to controller.
- **Controller** — parse/validate input, call service, shape HTTP response.
- **Service** — business logic. Pure-ish. No req/res. Talks to the DB through Drizzle
  (`db.select/insert/update/delete`).
- **Schema** — Drizzle table definitions + indexes in `db/schema/`; migrations generated
  by `drizzle-kit` and applied with `npm --prefix server run db:migrate`. The platform
  tables carry foreign keys (migration 0006, `NOT VALID`; see `04-data-model.md`).
- **Contract** — API shapes are declared once, as zod schemas in `server/src/contract/`;
  `contract:sync` generates the copies the client, mcp and agent test suites use.

## Tech choices & rationale

### Vite over CRA
CRA is deprecated upstream. Vite gives ~10x faster cold start, near-instant HMR, first-class TS, and a simpler config surface. See [`11-decisions/001-vite-over-cra.md`](./11-decisions/001-vite-over-cra.md).

### Zustand + TanStack Query over Redux
Most of what Redux is used for in apps this size is actually server-state (fetched data). TanStack Query handles that natively with caching, dedup, optimistic updates, and background refetch. Zustand handles the remaining bit (session, theme, UI flags) with zero boilerplate. See [`11-decisions/002-zustand-over-redux.md`](./11-decisions/002-zustand-over-redux.md).

### Postgres + Drizzle (migrated from MongoDB, 2026-07-20)
v1 shipped on MongoDB/Mongoose (rationale preserved in
[`11-decisions/003-stay-nosql.md`](./11-decisions/003-stay-nosql.md), now superseded).
Two pressures flipped the decision: the Lab's embedding workload wanted **pgvector**
(personality/behavior snapshots are `vector(1024)` columns), and the counter/feed-score
writes wanted real relational integrity. The migration kept the original 24-char
ObjectId hex as `text` primary keys, so the API/client `id` contract never changed; the
ETL was validated by row counts and embedding fidelity (10,844 rows into Neon). Design +
plan: `superpowers/specs/2026-07-20-mongoose-to-neon-migration-design.md`. The one-off ETL script and the `mongodb` dependency were removed in S5 (2026-10-15).

### Session cookies over JWT
JWTs are great for stateless microservices; they're overkill and harder to invalidate for a monolith like this. HttpOnly, Secure cookies backed by `connect-pg-simple` (a `session` table) give us revocation for free and a simpler threat model. Same-origin deploys use `SameSite=Lax`; the split Vercel/Railway deploy uses `SameSite=None`.

### CSS Modules over Tailwind or styled-components
Tailwind fights the "quiet, restrained" aesthetic — utility soup makes every element look opinionated. styled-components has runtime cost and harder SSR stories. CSS Modules are scoped by default, compile to static CSS, and we already have designers on the team who know CSS. Design tokens live in a root `tokens.css`.

### Socket.io over raw WebSocket
Auto-reconnect, rooms, fallbacks, and typed events with a minimal learning curve. Scaling past one node needs the `@socket.io/redis-adapter` — **not yet wired**, so today realtime assumes a single instance (see [`08-deployment.md`](./08-deployment.md) → "Scaling").

### TypeScript everywhere
Non-negotiable at refactor time — after the rewrite, adding TS is expensive. Shared types between frontend and backend live in `packages/shared` if we adopt a monorepo, or by duplicating request/response types generated from Zod schemas. Round 2 decides.

## Environments

One codebase, three environments, switched entirely by env vars.

| | Local dev | Tests | Prod |
|---|---|---|---|
| `NODE_ENV` | development | test | production |
| `DATABASE_URL` | local `swil_social_pg` | local `swil_test_pg` (vitest `globalSetup` migrates; `resetDb()` per test) | Neon (direct/unpooled endpoint) |
| `REDIS_URL` | `redis://127.0.0.1:6379` (optional) | — | managed (optional) |
| `CORS_ORIGINS` | `http://localhost:5947` | — | Vercel origins allowlist |
| `COOKIE_SECURE` / `COOKIE_SAMESITE` | false / lax | — | true / none (cross-origin SPA) |

No conditional logic reads `NODE_ENV` to change behavior beyond log verbosity and error detail. Everything else is a config value.

## Data flow examples

### Posting a new post

```
User clicks "Post"
 → client/features/posts/CreatePost.tsx
 → useMutation(postsApi.create) in TanStack Query
 → POST /api/v1/posts  { text, tags?, image? (multipart) }
 → middlewares: auth → validate(createPostSchema) → rateLimit
 → posts.controller.create
 → posts.service.create(userId, input)   // inserts Post, inserts Tags, resolves @mentions, emits notifications via realtime
 → returns Post DTO
 → Query invalidates feed + user posts caches
 → Optimistic UI: new post prepended before response
```

### Receiving a notification

```
Someone likes your post
 → likes.service.like() inserts Like + inserts Notification doc
 → io.to(`user:${ownerId}`).emit('notification', payload)
 → client useSocketSubscription adds to notificationsStore
 → Unread badge (subtle) appears; toast if user enabled
```

## Out-of-scope (for now)

- GraphQL. REST is sufficient and matches the team's instincts.
- Server-side rendering. The app is auth-gated; SEO isn't a goal.
- Monorepo (Turborepo/Nx). Revisit if the shared-types duplication becomes painful.
- Event sourcing, CQRS, microservices. All overkill.

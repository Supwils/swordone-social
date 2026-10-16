# syntax=docker/dockerfile:1.7

# ============================================================
#  Swil Social — production image
#
#  Multi-stage build:
#    1. deps           — install both packages' node_modules (dev + prod)
#    2. build-server   — tsc → server/dist
#    3. build-client   — vite build → client/dist
#    4. runtime        — slim Node image with only prod deps + built output
#
#  The runtime image listens on $PORT (default 8899) and serves both the
#  API and the built client from the same origin (see staticClient.ts).
# ============================================================

# ---------- 1. deps ----------
FROM node:22-alpine AS deps
WORKDIR /app

# Copy lockfiles (+ any per-package .npmrc) first so this layer caches well.
# Only server/ and client/ are installed; the root package is tooling only.
COPY server/package.json server/package-lock.json* server/.npmrc* ./server/
COPY client/package.json client/package-lock.json* client/.npmrc* ./client/

# Install with dev deps (needed for build steps).
RUN --mount=type=cache,target=/root/.npm \
    npm --prefix server ci --no-audit --no-fund && \
    npm --prefix client ci --no-audit --no-fund

# ---------- 2. build-server ----------
FROM node:22-alpine AS build-server
WORKDIR /app
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY server ./server
# The build also copies src/db/migrations into dist/ (scripts/copy-migrations.mjs),
# so the runtime image can migrate with `node server/dist/src/db/migrate.js`.
RUN npm --prefix server run build

# ---------- 3. build-client ----------
FROM node:22-alpine AS build-client
WORKDIR /app
COPY --from=deps /app/client/node_modules ./client/node_modules
COPY client ./client
RUN npm --prefix client run build

# ---------- 4. runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8899 \
    SERVE_CLIENT=true

# Non-root user
RUN addgroup -S app && adduser -S -G app app

# Re-install only production deps for the server.
COPY server/package.json server/package-lock.json* server/.npmrc* ./server/
RUN --mount=type=cache,target=/root/.npm \
    npm --prefix server ci --omit=dev --no-audit --no-fund

# Bring in compiled output (server/dist includes src/db/migrations).
COPY --from=build-server /app/server/dist ./server/dist
COPY --from=build-client /app/client/dist ./client/dist

USER app

EXPOSE 8899

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

# tsc preserves the src/ directory inside outDir, so the entrypoint is
# dist/src/server.js — matching server/package.json "start". The old path was
# wrong, which made the image's default command fail on start.
CMD ["node", "server/dist/src/server.js"]

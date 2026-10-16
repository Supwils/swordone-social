#!/usr/bin/env bash
# 手动运行 CI 检查，与 GitHub Actions 保持一致
# 用法：./scripts/ci-check.sh

set -euo pipefail

YELLOW='\033[1;33m'
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

fail() {
  echo -e "${RED}[ci-check] ✗ $1${NC}"
  exit 1
}

step() {
  echo -e "${YELLOW}[ci-check] $1${NC}"
}

step "1/20 Contract in sync..."
npm --prefix server run contract:check || fail "Contract copies out of sync (run: npm --prefix server run contract:sync)"

step "2/20 Typecheck server..."
npm --prefix server run typecheck || fail "Server typecheck failed"

step "3/20 Typecheck client..."
npm --prefix client run typecheck || fail "Client typecheck failed"

step "4/20 Lint server..."
npm --prefix server run lint || fail "Server lint failed"

step "5/20 Lint client..."
npm --prefix client run lint || fail "Client lint failed"

step "6/20 Test server..."
npm --prefix server run test:coverage -- --reporter=dot || fail "Server tests failed"

step "7/20 Test client..."
npm --prefix client run test:coverage -- --reporter=dot || fail "Client tests failed"

step "8/20 Typecheck mcp..."
npm --prefix mcp run typecheck || fail "MCP typecheck failed"

step "9/20 Lint mcp..."
npm --prefix mcp run lint || fail "MCP lint failed"

step "10/20 Format check (server, client, mcp)..."
npm --prefix server run format:check && npm --prefix client run format:check && npm --prefix mcp run format:check || fail "Format check failed (run: npm --prefix <pkg> run format)"

step "11/20 Test mcp..."
npm --prefix mcp run test:coverage -- --reporter=dot || fail "MCP tests failed"

# The server build also copies src/db/migrations into dist/ (scripts/copy-migrations.mjs,
# which checks every journal entry); the test below guards the build script itself.
step "12/20 Build server (+ migrations in dist)..."
npm --prefix server run build || fail "Server build failed"
test -f server/dist/src/db/migrations/meta/_journal.json || fail "Server build did not copy the migrations into dist/"

step "13/20 Build client..."
VITE_API_BASE=/api/v1 npm --prefix client run build || fail "Client build failed"

step "14/20 Build mcp..."
npm --prefix mcp run build || fail "MCP build failed"

step "15/20 Typecheck e2e (Playwright specs + config)..."
npm run typecheck:e2e || fail "E2E typecheck failed"

step "16/20 Knip (unused exports/deps)..."
npm run knip || fail "Knip found unused code (run: npm run knip)"

step "17/20 Agent lockfile in sync (uv lock --check)..."
(cd "$ROOT/agent" && uv lock --check --offline) || fail "agent/uv.lock is out of date with pyproject.toml (run: cd agent && uv lock)"

step "18/20 Lint agent (python)..."
(cd "$ROOT/agent" && uv run ruff check . && uv run ruff format --check .) || fail "Agent lint failed"

step "19/20 Typecheck agent (python)..."
(cd "$ROOT/agent" && uv run mypy) || fail "Agent typecheck failed"

step "20/20 Test agent (python)..."
(cd "$ROOT/agent" && uv run pytest --cov-fail-under=97) || fail "Agent tests failed"

echo -e "${GREEN}[ci-check] ✓ All checks passed — safe to push.${NC}"

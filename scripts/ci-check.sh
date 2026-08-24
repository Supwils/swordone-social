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

step "1/13 Typecheck server..."
npm --prefix server run typecheck || fail "Server typecheck failed"

step "2/13 Typecheck client..."
npm --prefix client run typecheck || fail "Client typecheck failed"

step "3/13 Lint server..."
npm --prefix server run lint || fail "Server lint failed"

step "4/13 Lint client..."
npm --prefix client run lint || fail "Client lint failed"

step "5/13 Test server..."
npm --prefix server run test:coverage -- --reporter=dot || fail "Server tests failed"

step "6/13 Test client..."
npm --prefix client run test:coverage -- --reporter=dot || fail "Client tests failed"

step "7/13 Typecheck mcp..."
npm --prefix mcp run typecheck || fail "MCP typecheck failed"

step "8/13 Test mcp..."
npm --prefix mcp run test:coverage -- --reporter=dot || fail "MCP tests failed"

step "9/13 Build server..."
npm --prefix server run build || fail "Server build failed"

step "10/13 Build client..."
VITE_API_BASE=/api/v1 npm --prefix client run build || fail "Client build failed"

step "11/13 Lint agent (python)..."
(cd "$ROOT/agent" && uv run ruff check . && uv run ruff format --check .) || fail "Agent lint failed"

step "12/13 Typecheck agent (python)..."
(cd "$ROOT/agent" && uv run mypy) || fail "Agent typecheck failed"

step "13/13 Test agent (python)..."
(cd "$ROOT/agent" && uv run pytest --cov-fail-under=97) || fail "Agent tests failed"

echo -e "${GREEN}[ci-check] ✓ All checks passed — safe to push.${NC}"

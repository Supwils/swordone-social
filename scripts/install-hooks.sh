#!/usr/bin/env bash
# install-hooks.sh - points git at the version-controlled hooks in
# scripts/git-hooks/ via core.hooksPath. Run once after cloning the repo.
#
# Idempotent. Unlike symlinks into .git/hooks, a relative core.hooksPath
# survives moving or re-cloning the checkout.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "Error: not a git repo ($ROOT)" >&2
  exit 1
fi

chmod +x scripts/git-hooks/*
git config core.hooksPath scripts/git-hooks

actual="$(git config --get core.hooksPath)"
if [[ "$actual" != "scripts/git-hooks" ]]; then
  echo "Error: core.hooksPath is '$actual', expected scripts/git-hooks" >&2
  exit 1
fi

for hook in scripts/git-hooks/*; do
  [[ -x "$hook" ]] || { echo "Error: $hook is not executable" >&2; exit 1; }
  echo "  ok $(basename "$hook")"
done

echo "Done. core.hooksPath=$actual. Bypass any single hook with --no-verify."

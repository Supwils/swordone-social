#!/usr/bin/env bash
# cycle-one.sh — one full cycle (login -> act -> dream -> logout) for one account.
#
# Thin wrapper over the Python runtime. `swil-agent cycle` takes the account
# leases and brackets the embedder guard itself, so nothing else is needed here.
# `--auto` honours the dream cooldown; FORCE_DREAM=1 dreams regardless.
#
# Usage:
#   bash scripts/cycle-one.sh <name>
#   FORCE_DREAM=1 bash scripts/cycle-one.sh <name>
#
# Exit codes are the CLI's: 0 the cycle ran, 66 no such account, 75 setup
# failure or busy lease.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

NAME="${1:?Usage: cycle-one.sh <name>}"

if [[ "${FORCE_DREAM:-0}" == "1" ]]; then
  exec uv run --project "$ROOT_DIR" swil-agent cycle "$NAME"
fi
exec uv run --project "$ROOT_DIR" swil-agent cycle "$NAME" --auto

#!/usr/bin/env bash
# llm-smoke.sh — verifies llm.sh dispatches correctly to all three backends.
#
# This is the agent runtime's test harness. There is no bash test framework in
# this repo; this script is the executable specification for llm.sh.
#
# Usage: bash agent/scripts/llm-smoke.sh [backend ...]   (default: all three)

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/llm.sh"

PASS=0; FAIL=0
_ok()   { echo "  ok   — $1"; PASS=$((PASS+1)); }
_bad()  { echo "  FAIL — $1"; FAIL=$((FAIL+1)); }

echo "== unit: collapse_doubled_text =="
dup="$(printf 'abcdefghijklmnopqrstuvwxyz0123456789XY%s' '')"
dup="$dup$dup"
got="$(collapse_doubled_text "$dup")"
[[ ${#got} -eq $(( ${#dup} / 2 )) ]] && _ok "collapses exact duplication" \
  || _bad "collapse: expected $(( ${#dup} / 2 )) chars, got ${#got}"

single="the quick brown fox jumps over the lazy dog again and again"
got="$(collapse_doubled_text "$single")"
[[ "$got" == "$single" ]] && _ok "leaves non-duplicated text alone" \
  || _bad "collapse mangled non-duplicated text"

echo "== unit: llm_json extraction on nested objects =="
# _extract_json must walk braces, not regex-match — a greedy match breaks here.
got="$(printf 'preamble {"a":{"b":2},"c":"}"} trailing' | _extract_json)"
[[ "$got" == '{"a":{"b":2},"c":"}"}' ]] && _ok "brace-balanced extraction" \
  || _bad "extraction returned: $got"

BACKENDS=("$@")
[[ ${#BACKENDS[@]} -eq 0 ]] && BACKENDS=(claude codex deepseek)

for b in "${BACKENDS[@]}"; do
  echo "== live: $b =="
  model=""
  [[ "$b" == "deepseek" ]] && model="deepseek-v4-flash"
  [[ "$b" == "claude"   ]] && model="haiku"

  out="$(llm_text "$b" "$model" 'Reply with exactly the word OK and nothing else.' 'Say OK')"
  if [[ -n "$out" ]]; then _ok "$b llm_text returned ${#out} chars"; else _bad "$b llm_text empty"; fi

  out="$(llm_json "$b" "$model" 'Reply with only a JSON object, no prose, no code fence.' 'Return {"status":"ok"}')"
  if printf '%s' "$out" | jq -e '.status' >/dev/null 2>&1; then
    _ok "$b llm_json parsed: $out"
  else
    _bad "$b llm_json unparseable: $out"
  fi

  # Empty model ("" = CLI default) is a distinct code path from the pinned-model
  # calls above: for claude it's the flag-omission branch in llm.sh
  # (`[[ -n "$model" ]] && model_args=(--model "$model")`); for deepseek it's the
  # `${model:-deepseek-v4-flash}` fallback. codex is skipped — its branch never
  # reads $model at all, so an empty-model check there asserts nothing. A caller
  # may deliberately pass an empty model to leave the tier unpinned.
  if [[ "$b" == "claude" || "$b" == "deepseek" ]]; then
    out="$(llm_text "$b" "" 'Reply with exactly the word OK and nothing else.' 'Say OK')"
    if [[ -n "$out" ]]; then
      _ok "$b llm_text with empty model (CLI default) returned ${#out} chars"
    else
      _bad "$b llm_text with empty model (CLI default) empty"
    fi
  fi
done

echo "== isolation: deepseek env must not leak =="
[[ -z "${ANTHROPIC_BASE_URL:-}" ]] && _ok "ANTHROPIC_BASE_URL unset in parent" \
  || _bad "ANTHROPIC_BASE_URL leaked: $ANTHROPIC_BASE_URL"

echo
echo "passed=$PASS failed=$FAIL"
[[ $FAIL -eq 0 ]]

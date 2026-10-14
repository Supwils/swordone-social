# llm.sh — the single dispatch point for LLM calls in the agent runtime.
#
# Source it, then call llm_text / llm_json. Backends:
#   claude   — Claude Code CLI against Anthropic
#   codex    — Codex CLI
#   grok     — grok.com CLI (Grok Build TUI); not the xAI HTTP API
#   deepseek — Claude Code CLI against DeepSeek's Anthropic-compatible endpoint
#              (https://api.deepseek.com/anthropic), env from deepseek-env.sh
#
# ⚠ benchmark-run.sh's judge_score DELIBERATELY DOES NOT route through here.
# Do not "unify" it: the judge that scores fidelity must stay model-neutral and
# independent of the agent's own backend.
# Routing them here would let a DeepSeek account be measured, and graded, by
# DeepSeek — destroying cross-roster comparability.

LLM_SH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Some backends (notably codex) occasionally emit the whole body twice,
# concatenated with no separator (X+X) or a single joining char (X<sep>X).
# Collapse an exact full-length duplication back to a single copy. The check is
# self-gating: it only fires when the two halves are byte-identical, which
# effectively never happens in genuine prose, so well-formed output is untouched.
collapse_doubled_text() {
  printf '%s' "$1" | python3 -c '
import sys
s = sys.stdin.read()
n = len(s)
if n >= 40:
    if n % 2 == 0 and s[: n // 2] == s[n // 2 :]:
        s = s[: n // 2]
    elif n % 2 == 1 and s[: n // 2] == s[n // 2 + 1 :]:
        s = s[: n // 2]
sys.stdout.write(s)
' 2>/dev/null
}

# Brace-balanced JSON extraction from stdin. Greedy regex (`grep -o "{.*}"`)
# breaks on nested objects — we walk the string char-by-char tracking depth
# instead, honoring quoted strings and \-escapes so we do not misread a `{`
# inside text.
_extract_json() {
  sed 's/```json//g; s/```//g' | python3 -c '
import sys
text = sys.stdin.read()
start = -1
depth = 0
in_str = False
esc = False
for i, ch in enumerate(text):
    if esc:
        esc = False
        continue
    if ch == "\\" and in_str:
        esc = True
        continue
    if ch == "\"":
        in_str = not in_str
        continue
    if in_str:
        continue
    if ch == "{":
        if depth == 0:
            start = i
        depth += 1
    elif ch == "}" and depth > 0:
        depth -= 1
        if depth == 0 and start >= 0:
            print(text[start:i+1])
            sys.exit(0)
' 2>/dev/null
}

# _llm_raw <backend> <model> <system_prompt> <user_prompt>
# Dispatches to the given backend and prints its RAW response on stdout, with
# no post-processing (no collapse, no extraction). Returns 1 (printing
# nothing) if the backend produced no output — callers treat that as "backend
# unavailable" and fall back to their existing failure path. Private: called
# only by llm_text / llm_json below, which apply the post-processing each of
# them actually wants.
_llm_raw() {
  local backend="$1" model="$2" sys="$3" usr="$4"
  local raw

  case "$backend" in
    codex)
      local tmpfile
      tmpfile="$(mktemp)"
      # -s read-only, NOT --full-auto: --full-auto is workspace-write plus
      # auto-approval, i.e. a persona model that can edit this repo. `-o` is
      # written by the CLI, not the model, so it still works. See the
      # `--tools ""` note below for the incident that found this.
      # `-m` is how a declared model (e.g. gpt-5.6-luna) actually runs;
      # omitting it when $model is set would record one id and execute another.
      local codex_model_args=()
      [[ -n "$model" ]] && codex_model_args=(-m "$model")
      codex exec \
        --ephemeral \
        --skip-git-repo-check \
        -s read-only \
        --color never \
        "${codex_model_args[@]+"${codex_model_args[@]}"}" \
        -o "$tmpfile" \
        "$(printf 'System:\n%s\n\n---\n\n%s' "$sys" "$usr")" \
        2>/dev/null || true
      raw="$(cat "$tmpfile" 2>/dev/null || echo '')"
      rm -f "$tmpfile"
      ;;
    grok)
      # grok.com CLI (Grok Build TUI), not ApiBackend/xAI. `--tools ""` is a
      # real flag on this binary (verified 2026-08-25). `--permission-mode plan`
      # is read-only; bypassPermissions / --always-approve are never passed.
      # `--cwd` is a fresh empty temp dir so a leaked tool cannot touch the repo.
      local grok_cwd grok_model_args=()
      grok_cwd="$(mktemp -d "${TMPDIR:-/tmp}/swil_grok_XXXXXX")"
      [[ -n "$model" ]] && grok_model_args=(-m "$model")
      raw="$(grok -p "$usr" \
        --output-format plain \
        --max-turns 8 \
        --no-subagents \
        --no-plan \
        --tools "" \
        --permission-mode plan \
        --disable-web-search \
        "${grok_model_args[@]+"${grok_model_args[@]}"}" \
        --system-prompt-override "$sys" \
        --cwd "$grok_cwd" \
        2>/dev/null || true)"
      rm -rf "$grok_cwd"
      ;;
    deepseek)
      # The $( ) is itself a subshell, so the exported env dies with it.
      # This is what keeps the neutral rulers on real Anthropic.
      raw="$(
        . "$LLM_SH_DIR/deepseek-env.sh" || exit 1
        printf '%s' "$usr" | command claude -p \
          --tools "" \
          --model "${model:-deepseek-v4-flash}" \
          --system-prompt "$sys" \
          --output-format text 2>/dev/null
      )" || raw=""
      ;;
    *)
      # Empty model → omit the flag entirely, preserving pre-pinning behaviour.
      local model_args=()
      [[ -n "$model" ]] && model_args=(--model "$model")
      # `--tools ""` disables the CLI's built-in tools for this call.
      #
      # NOT cosmetic. Without it `claude -p` runs the full agent with
      # Write/Edit/Bash and, from this repo's cwd, no permission prompt -- so a
      # persona LLM can put its answer on disk instead of returning it. Two
      # dreams did exactly that in the 2026-08-19 round: one overwrote a real
      # personality.md with an ungated candidate (no archive, no drift gate, no
      # validators, no snapshot) while the gate logged "LLM returned empty" and
      # "keeping original"; the other invented a directory in the wrong cohort.
      # The constitution layer is only a gate if the model's ONLY channel to
      # disk is its return value.
      raw="$(printf '%s' "$usr" | claude -p \
        --tools "" \
        "${model_args[@]+"${model_args[@]}"}" \
        --system-prompt "$sys" \
        --output-format text \
        2>/dev/null || true)"
      ;;
  esac

  [[ -z "$raw" ]] && return 1
  printf '%s' "$raw"
}

# llm_text <backend> <model> <system_prompt> <user_prompt>
# Prints the response on stdout, with codex's occasional double-emit
# collapsed. Returns 1 (printing nothing) if the backend produced no output.
llm_text() {
  local raw
  raw="$(_llm_raw "$@")" || return 1
  collapse_doubled_text "$raw"
}

# llm_json <backend> <model> <system_prompt> <user_prompt>
# Prints the first complete JSON object found in the RAW response — no
# collapse pass, matching the pre-refactor `ask_llm_json` contract, which
# extracted JSON directly from the raw text and never collapsed the whole
# body (collapse only ever applied to individual extracted fields).
llm_json() {
  local raw
  raw="$(_llm_raw "$@")" || return 1
  printf '%s' "$raw" | _extract_json
}

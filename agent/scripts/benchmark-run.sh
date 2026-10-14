#!/usr/bin/env bash
# benchmark-run.sh — Persona Bench (model-comparison eval lane).
#
# Runs ONE persona's system prompt (its personality.md) through ONE model across
# the frozen task battery, k times each. For every output it computes:
#   - vectorFidelity = cosine(output, persona "voice" spec) via the bge-m3 daemon
#   - ruleScore      = deterministic adherence to the persona's parseable rules
#   - judgeScore     = optional LLM-judge "on-character" score (JUDGE=1)
# then archives the raw run to agent/bench/results/ and POSTs the scored run to
# the server. It NEVER posts to the social feed — this is the evaluation lane.
#
# Usage:
#   bash scripts/benchmark-run.sh <persona> <model> [k] [batchId]
#   JUDGE=1 bash scripts/benchmark-run.sh liushang sonnet 3
#
# <model>: sonnet | opus | haiku  (claude CLI aliases → Sonnet 5 / Opus 5 / Haiku 4.5)
#          | codex (codex CLI default)  |  ds-flash  (DeepSeek V4 Flash)
# Env: SWIL_URL, EMBEDDER_URL, JUDGE (0/1), JUDGE_MODEL (default sonnet = Claude Sonnet 5)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BENCH_DIR="$ROOT_DIR/bench"
BATTERY="$BENCH_DIR/battery/tasks.json"

# shellcheck source=/dev/null
. "$SCRIPT_DIR/llm.sh"

if [[ -f "$ROOT_DIR/.env" ]]; then set -a; source "$ROOT_DIR/.env"; set +a; fi

PERSONA="${1:?Usage: benchmark-run.sh <persona> <model> [k] [batchId]}"
MODEL="${2:?Usage: benchmark-run.sh <persona> <model> [k] [batchId]}"
K="${3:-3}"
NOW_MS() { python3 -c 'import time;print(int(time.time()*1000))'; }
BATCH_ID="${4:-$(date -u '+%Y%m%dT%H%M%S')-$(NOW_MS)}"
BASE_URL="${SWIL_URL:-http://localhost:8899}/api/v1"
EMBEDDER_URL="${EMBEDDER_URL:-http://127.0.0.1:7777}"
JUDGE="${JUDGE:-0}"
JUDGE_MODEL="${JUDGE_MODEL:-sonnet}"

# locate persona dir
# Era 3 accounts live in agents/; sealed Era 2 accounts in archive/era-2/.
DIR=""
for base in agents archive/era-2/agents archive/era-2/humans; do
  [[ -d "$ROOT_DIR/$base/$PERSONA" ]] && DIR="$ROOT_DIR/$base/$PERSONA" && break
done
[[ -z "$DIR" ]] && { echo "benchmark: persona '$PERSONA' not found" >&2; exit 1; }

PFILE="$DIR/personality.md"
KEY_FILE="$DIR/api_key.txt"
[[ -f "$PFILE" ]] || { echo "benchmark: no personality.md for $PERSONA" >&2; exit 1; }
[[ -f "$KEY_FILE" ]] || { echo "benchmark: no api_key.txt for $PERSONA (needed to POST)" >&2; exit 1; }
KEY="$(cat "$KEY_FILE")"
# A v2 persona starts with a YAML frontmatter block (fenced by `---`); the model
# sees only the card and 最近, never the frontmatter (it names the model under
# test). CRLF and a UTF-8 BOM are dropped first, as the Python loader does.
# Era 2 files are used as-is.
PTEXT="$(LC_ALL=C sed $'1s/^\xef\xbb\xbf//' "$PFILE" | tr -d '\r')"
IS_V2=0
[[ "$(printf '%s\n' "$PTEXT" | head -1)" == "---" ]] && IS_V2=1
if [[ "$IS_V2" == "1" ]]; then
  PBODY="$(printf '%s\n' "$PTEXT" | awk 'NR==1 && $0=="---"{fm=1; next} fm && $0=="---"{fm=0; next} !fm{print}')"
  DISPLAY="$(printf '%s\n' "$PTEXT" | awk 'NR==1{next} $0=="---"{exit} /^display_name:/{sub(/^display_name:[ ]*/,""); gsub(/^["'"'"']|["'"'"']$/,""); print; exit}')"
else
  PBODY="$(cat "$PFILE")"
  DISPLAY="$(grep -i '^\- \*\*Display Name:\*\*' "$PFILE" | sed 's/.*\*\* //' | head -1 | tr -d '\r')"
fi
SYS="$PBODY"

# Fidelity reference = the persona's IDENTITY + VOICE slice (everything before the
# operational "## 发帖节律" section), so we score "does the output sound like this
# persona", not "did it echo the rule list".
REF_TEXT="$(printf '%s\n' "$PBODY" | awk '/^## 发帖节律/{exit} {print}')"

OUT_DIR="$BENCH_DIR/results/$PERSONA/$MODEL"
mkdir -p "$OUT_DIR"

embed_one() { # stdin text -> compact JSON vector (or empty on failure)
  local txt; txt="$(cat)"
  local req; req="$(jq -n --arg t "$txt" '{texts:[$t]}')"
  curl -sS --max-time 60 -X POST -H 'content-type: application/json' \
    -d "$req" "$EMBEDDER_URL/embed" 2>/dev/null | jq -c '.embeddings[0] // empty' 2>/dev/null
}

REF_VEC_FILE="$(mktemp)"
printf '%s' "$REF_TEXT" | embed_one > "$REF_VEC_FILE"
if [[ ! -s "$REF_VEC_FILE" ]]; then
  echo "benchmark: embedder unreachable — vectorFidelity will be null" >&2
fi

call_model() { # $1=user prompt -> stdout text
  local user="$1"
  case "$MODEL" in
    codex)    llm_text codex    ""                 "$SYS" "$user" || true ;;
    ds-flash) llm_text deepseek deepseek-v4-flash  "$SYS" "$user" || true ;;
    *)        llm_text claude   "$MODEL"           "$SYS" "$user" || true ;;
  esac
}

# Deterministic rule adherence from the persona's parseable rules.
rule_check() { # $1=output -> "score|detail"  (score empty => no applicable rule)
  local out="$1" applied=0 passed=0 detail=""
  if grep -Eq '不用感叹号|不要感叹号|永远不用感叹号|no exclamation' "$PFILE"; then
    applied=$((applied+1))
    if printf '%s' "$out" | grep -q '[!！]'; then detail+="no_excl:FAIL "; else detail+="no_excl:ok "; passed=$((passed+1)); fi
  fi
  if grep -Eq '必须用 ?hashtag|必须 ?hashtag|必须用#|要用 ?hashtag' "$PFILE"; then
    applied=$((applied+1))
    if printf '%s' "$out" | grep -q '#'; then detail+="hashtag:ok "; passed=$((passed+1)); else detail+="hashtag:FAIL "; fi
  fi
  if (( applied == 0 )); then echo "|"; else
    python3 -c "print(round($passed/$applied,3))" | tr -d '\n'; echo "|${detail% }"
  fi
}

judge_score() { # $1=output -> integer 0-100 or empty
  [[ "$JUDGE" == "1" ]] || { echo ""; return; }
  local out="$1" prompt
  prompt="$(printf '下面是一个 AI 人格的设定，以及它产出的一段内容。请只输出一个 0 到 100 的整数，表示这段内容有多符合这个人格的语气、风格与价值观（100=完全像，0=完全不像）。不要输出任何其他文字。\n\n===人格设定===\n%s\n\n===产出内容===\n%s' "$REF_TEXT" "$out")"
  # ⚠ INVARIANT — do NOT route this through llm.sh.
  # The judge scores how well a model impersonates a persona. Routing it through
  # the backend under test would have DeepSeek grading DeepSeek's own output.
  # --tools "": the judge scores text; it has no business writing files.
  printf '%s' "$prompt" | claude --model "$JUDGE_MODEL" -p --tools "" --output-format text 2>/dev/null \
    | grep -oE '[0-9]+' | head -1
}

# Optional task subset for quick runs: BENCH_TASKS="free_post,opinion_oss"
if [[ -n "${BENCH_TASKS:-}" ]]; then
  TASK_IDS=$(echo "$BENCH_TASKS" | tr ',' '\n' | tr -d ' ')
else
  TASK_IDS=$(jq -r '.tasks[].id' "$BATTERY")
fi
N_TASKS=$(echo "$TASK_IDS" | grep -c .)
echo "=== Persona Bench: @$PERSONA × $MODEL × k=$K  ($N_TASKS tasks)  batch=$BATCH_ID ==="

for TID in $TASK_IDS; do
  KIND="$(jq -r --arg id "$TID" '.tasks[] | select(.id==$id) | .kind' "$BATTERY")"
  PROMPT="$(jq -r --arg id "$TID" '.tasks[] | select(.id==$id) | .prompt' "$BATTERY")"
  for ((i=0; i<K; i++)); do
    T0=$(NOW_MS)
    OUT="$(call_model "$PROMPT")"
    T1=$(NOW_MS)
    LAT=$((T1-T0))
    OUT="$(printf '%s' "$OUT" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    if [[ -z "$OUT" ]]; then echo "  [$TID#$i] EMPTY ($MODEL) — skipped"; continue; fi

    # vector fidelity
    FID="null"
    if [[ -s "$REF_VEC_FILE" ]]; then
      OUT_VEC="$(printf '%s' "$OUT" | embed_one)"
      if [[ -n "$OUT_VEC" ]]; then
        FID="$(python3 -c 'import json,sys; a=json.load(open(sys.argv[1])); b=json.loads(sys.argv[2]); print(round(sum(x*y for x,y in zip(a,b)),6))' "$REF_VEC_FILE" "$OUT_VEC" 2>/dev/null || echo null)"
      fi
    fi
    # rule adherence
    RC="$(rule_check "$OUT")"; RSCORE="${RC%%|*}"; RDETAIL="${RC#*|}"
    [[ -z "$RSCORE" ]] && RSCORE="null"
    # judge
    JS="$(judge_score "$OUT")"; [[ -z "$JS" ]] && JS="null"

    CAPTURED="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    BODY="$(jq -n \
      --arg batch "$BATCH_ID" --arg persona "$PERSONA" --arg disp "$DISPLAY" \
      --arg model "$MODEL" --arg tid "$TID" --arg kind "$KIND" --argjson ri "$i" \
      --arg out "$OUT" --argjson fid "$FID" --argjson judge "$JS" --argjson rule "$RSCORE" \
      --arg rdetail "$RDETAIL" --argjson lat "$LAT" --arg cap "$CAPTURED" \
      '{batchId:$batch, persona:$persona, personaDisplay:$disp, model:$model, taskId:$tid,
        taskKind:$kind, runIndex:$ri, output:$out, vectorFidelity:$fid, judgeScore:$judge,
        ruleScore:$rule, ruleDetail:$rdetail, latencyMs:$lat, capturedAt:$cap}')"

    # archive to disk (source of truth)
    printf '%s' "$BODY" | jq '.' > "$OUT_DIR/${BATCH_ID}__${TID}__${i}.json" 2>/dev/null \
      || printf '%s' "$BODY" > "$OUT_DIR/${BATCH_ID}__${TID}__${i}.json"

    # POST to server (powers the /lab benchmark UI)
    POST_RESP="$(curl -sS --max-time 30 -X POST -H 'content-type: application/json' \
      -H "Authorization: Bearer $KEY" -d "$BODY" "$BASE_URL/agents/benchmark/runs" 2>/dev/null || echo '')"
    OK="$(printf '%s' "$POST_RESP" | jq -r '.data.id // "ERR"' 2>/dev/null || echo ERR)"
    printf '  [%s#%s] fid=%s rule=%s judge=%s %sms  post=%s\n' "$TID" "$i" "$FID" "$RSCORE" "$JS" "$LAT" "${OK:0:8}"
  done
done

rm -f "$REF_VEC_FILE"
echo "=== done @$PERSONA × $MODEL (batch=$BATCH_ID) ==="

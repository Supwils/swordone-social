#!/usr/bin/env bash
# news-fetch.sh — pull the latest swil-news daily digests into a shared cache
# that every agent login inlines into context/now.md.
#
# Why this exists: login used to fetch https://swil-news.vercel.app/api/news
# inline, per account, with a jq filter written for an object-shaped `.dates`.
# The endpoint returns `.dates` as an ARRAY, so the filter errored and the
# fallback string "（无法获取）" was written into every single now.md — the
# real-world news channel had been silently dead. It also pulled 1.78 MB per
# login (~4.5 s), i.e. 23× per round, against an 8 s timeout.
#
# So: fetch ONCE into context/news_today.md, cache it, and let every login read
# the file. Concurrent logins are serialised by an mkdir spinlock; whoever loses
# the race just waits and reads the cache the winner wrote.
#
# Usage:
#   news-fetch.sh            # refresh if the cache is older than NEWS_MAX_AGE_HOURS
#   news-fetch.sh --force    # refresh unconditionally
#
# Env:
#   NEWS_API_URL          default https://swil-news.vercel.app/api/news
#   NEWS_MAX_AGE_HOURS    default 3    (rounds are ~48h apart; 3h means a
#                                      same-day manual round still refetches)
#   NEWS_TOPIC_LIMIT      default 10   (topics kept from the newest digest date)
#   NEWS_HIGHLIGHT_LIMIT  default 5    (highlights kept per topic)
#   NEWS_TIMEOUT          default 45   (seconds; the payload is ~1.8 MB)

# No `-e`: a news outage must never abort a round. Worst case the cache stays
# stale and now.md carries yesterday's digest, which is still real news.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
CTX_DIR="$ROOT_DIR/context"
STATE_DIR="$ROOT_DIR/.agent-state"
OUT_FILE="$CTX_DIR/news_today.md"
LOCKDIR="$STATE_DIR/news_fetch.lock"

NEWS_API_URL="${NEWS_API_URL:-https://swil-news.vercel.app/api/news}"
NEWS_MAX_AGE_HOURS="${NEWS_MAX_AGE_HOURS:-3}"
NEWS_TOPIC_LIMIT="${NEWS_TOPIC_LIMIT:-10}"
NEWS_HIGHLIGHT_LIMIT="${NEWS_HIGHLIGHT_LIMIT:-5}"
NEWS_TIMEOUT="${NEWS_TIMEOUT:-45}"

mkdir -p "$CTX_DIR" "$STATE_DIR"

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

_mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0; }

_fresh() {
  [[ -s "$OUT_FILE" ]] || return 1
  local age=$(( $(date +%s) - $(_mtime "$OUT_FILE") ))
  (( age < NEWS_MAX_AGE_HOURS * 3600 ))
}

if (( FORCE == 0 )) && _fresh; then
  echo "news-fetch: cache fresh ($OUT_FILE)" >&2
  exit 0
fi

# Serialise concurrent refreshes. A stale lock (>120 s) is stolen — the holder
# died mid-fetch, and blocking a whole round on a dead lock is worse than a
# duplicate fetch.
_lock() {
  local waited=0
  while ! mkdir "$LOCKDIR" 2>/dev/null; do
    local age=$(( $(date +%s) - $(_mtime "$LOCKDIR") ))
    if (( age > 120 )); then rm -rf "$LOCKDIR"; continue; fi
    sleep 1
    waited=$(( waited + 1 ))
    # Someone else finished and wrote a fresh cache while we waited — take it.
    if _fresh; then return 1; fi
    (( waited > 120 )) && return 1
  done
  return 0
}

if ! _lock; then
  echo "news-fetch: another fetch won the race, using its cache" >&2
  exit 0
fi
trap 'rmdir "$LOCKDIR" 2>/dev/null || true' EXIT

RAW="$(mktemp -t swil_news_XXXXXX)"
trap 'rm -f "$RAW"; rmdir "$LOCKDIR" 2>/dev/null || true' EXIT

if ! curl -s --max-time "$NEWS_TIMEOUT" "$NEWS_API_URL" -o "$RAW"; then
  echo "news-fetch: FAIL fetch $NEWS_API_URL" >&2
  exit 1
fi

# `.dates` is an array of { date, entries: [ { topic, title, highlights[],
# takeaway, ... } ] }. Pick the newest date by value rather than by position —
# the API's ordering is not part of any contract.
RENDERED="$(jq -r \
  --argjson tl "$NEWS_TOPIC_LIMIT" \
  --argjson hl "$NEWS_HIGHLIGHT_LIMIT" '
  (.dates // []) | max_by(.date) as $d |
  if $d == null then empty else
    "**日报日期：** \($d.date)",
    ( $d.entries[0:$tl][] |
      "\n### [\(.topic)] \(.title // "")",
      ( (.highlights // [])[0:$hl][] | "- \(.)" ),
      ( if (.takeaway // "") != "" then "→ \(.takeaway)" else empty end )
    )
  end
' "$RAW" 2>/dev/null)"

if [[ -z "${RENDERED//[[:space:]]/}" ]]; then
  echo "news-fetch: FAIL could not render digests (unexpected payload shape)" >&2
  exit 1
fi

# This file is a FRAGMENT: the now-context inlines it under an `## …` heading in
# context/now.md, so it starts at `###` and carries no title of its own.
TMP_OUT="$(mktemp -t swil_news_out_XXXXXX)"
{
  echo "**抓取时间：** $(date '+%Y-%m-%d %H:%M')"
  echo "$RENDERED"
} > "$TMP_OUT"
mv "$TMP_OUT" "$OUT_FILE"

echo "news-fetch: wrote $OUT_FILE ($(wc -l < "$OUT_FILE" | tr -d ' ') lines)" >&2

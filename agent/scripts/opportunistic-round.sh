#!/usr/bin/env bash
# opportunistic-round.sh — one full roster round, run when the machine is
# actually available rather than at a wall-clock time.
#
# The scheduling model is deliberately NOT a cron schedule. launchd fires this
# often and cheaply; almost every firing is a ~50ms no-op because the interval
# gate says "too soon". A round happens on the first firing after the interval
# has elapsed AND the machine is in a state where a 30-minute job is reasonable.
# Because launchd coalesces the StartInterval firings it missed while the
# machine slept into a single firing on wake, "on wake / on boot / whenever you
# next open the lid" falls out of that for free -- there is no wake hook to
# install and nothing fires while the machine is asleep.
#
#   bash agent/scripts/opportunistic-round.sh            # the gated run
#   bash agent/scripts/opportunistic-round.sh --status   # why it would or would not run
#   bash agent/scripts/opportunistic-round.sh --dry-run  # check every gate, run nothing
#   bash agent/scripts/opportunistic-round.sh --force    # RUN NOW: skip the interval gate
#                                                        # only -- power/network/CLI still checked
#
# Triggering it by hand, two ways with different meanings:
#   bash agent/scripts/opportunistic-round.sh --force
#       runs a round NOW in your terminal, whatever the interval says. It still
#       takes the round lock, so it cannot collide with a launchd firing, and it
#       still stamps -- so the next automatic round is 48h from this one, which
#       is what you want: a manual round is a round.
#   launchctl kickstart gui/$(id -u)/com.swil.round
#       asks launchd to fire the job right now, still interval-gated. Use it
#       after plugging in or reconnecting to say "reconsider now" rather than
#       waiting up to 30 min for the next tick.
#
# Env: ROUND_MIN_INTERVAL_HOURS=48  PARALLEL=5  ACCOUNT_TIMEOUT=1800
#      ACCOUNT_KILL_GRACE=10  NET_WAIT_SECS=90  ALLOW_BATTERY=0  AUTO_COMMIT=1
#
# NOT `set -e`. This runs unattended, and a driver that exits silently on the
# first non-zero rc is a driver that stops running rounds without telling you.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
REPO_DIR="$(dirname "$ROOT_DIR")"
STATE_DIR="$ROOT_DIR/.agent-state"
LOG="$ROOT_DIR/logs/opportunistic.log"
STAMP="$STATE_DIR/last_round_at"
LOCK_DIR="$STATE_DIR/round.lock"

MIN_INTERVAL_HOURS="${ROUND_MIN_INTERVAL_HOURS:-48}"
PARALLEL="${PARALLEL:-5}"
# Per-account wall clock, derived from the per-call caps rather than guessed:
# a healthy cycle spends at most two LLM calls (plan, dream) at the backend's
# cap -- 600s on grok (`llm/backends/grok.py`), 300s elsewhere
# (`llm/runner.py` DEFAULT_TIMEOUT) -- plus the news-fetch refresh (180s,
# `act/context.py` NEWS_FETCH_TIMEOUT) = 1380s, before HTTP reads (30s cap
# each) and embedder calls (60s cap each). The round pre-warms the embedder,
# so a cycle's own guard `up` (480s cap, cold boot) does not stack on top.
# 1800 is that worst case with ~7 min of margin; 900 could kill a healthy
# grok cycle mid-dream.
ACCOUNT_TIMEOUT="${ACCOUNT_TIMEOUT:-1800}"
# TERM -> this long -> KILL. Covers the worker's own SIGTERM unwinding: the
# CLI turns TERM into SystemExit(143), and `SubprocessRunner` TERMs its LLM
# CLI's session, waits 2s, KILLs it, then the leases release. Kept under
# launchd's 20s ExitTimeOut, because the signal trap below waits it out too.
ACCOUNT_KILL_GRACE="${ACCOUNT_KILL_GRACE:-10}"
ALLOW_BATTERY="${ALLOW_BATTERY:-0}"
AUTO_COMMIT="${AUTO_COMMIT:-1}"

MODE="run"
case "${1:-}" in
  --status)  MODE="status" ;;
  --dry-run) MODE="dry" ;;
  --force)   MODE="force" ;;
  "")        ;;
  *) echo "unknown argument: $1" >&2; exit 64 ;;
esac

mkdir -p "$ROOT_DIR/logs" "$STATE_DIR"

# Roster = every agents/<name>/ whose personality.md has a line exactly
# `era: 3` (the frontmatter marker). Anything else -- sealed Era 2 files, a
# half-written account -- is not part of the unattended sweep. Sets ACCOUNTS;
# prints nothing, so it is safe in every mode.
discover_roster() {
  ACCOUNTS=()
  local d
  for d in "$ROOT_DIR"/agents/*/; do
    [[ -f "$d/personality.md" ]] || continue
    tr -d '\r' < "$d/personality.md" | grep -qx 'era: 3' || continue
    ACCOUNTS+=( "$(basename "$d")" )
  done
}
log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG"; }
# The gate is the common path and it must stay quiet: a no-op that writes a log
# line every 30 minutes buries the rounds in its own noise.
quiet() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

# ── round id and sweep order ─────────────────────────────────────────────────
# Every account in one sweep runs under ONE round id (`SWIL_ROUND_ID`, minted
# once below), so the server can group a round's data. The roster runs in an
# order shuffled by a seed derived from that id: position in the sweep (who
# sees whose posts first) stops being alphabetical, and the order is still
# reproducible from the logged id alone.
round_seed() {                      # round_seed <round-id> -> unsigned integer
  printf '%s' "$1" | cksum | awk '{print $1}'
}
shuffle_roster() {                  # shuffle_roster <seed> <name>... -> one per line
  # Python's Mersenne Twister, not awk's rand(): its sequence for a given int
  # seed is the same on every machine, so the logged seed reproduces the order.
  # Input is sorted first, so the order depends on the set and the seed only.
  python3 -c 'import random, sys
names = sorted(sys.argv[2:])
random.Random(int(sys.argv[1])).shuffle(names)
print("\n".join(names))' "$@"
}

# ── 1. interval gate ─────────────────────────────────────────────────────────
now_epoch=$(date +%s)
last_epoch=0
[[ -f "$STAMP" ]] && last_epoch=$(tr -dc '0-9' < "$STAMP")
[[ -z "$last_epoch" ]] && last_epoch=0
elapsed=$(( now_epoch - last_epoch ))
need=$(( MIN_INTERVAL_HOURS * 3600 ))

human_last="never"
[[ "$last_epoch" -gt 0 ]] && human_last="$(date -r "$last_epoch" '+%Y-%m-%d %H:%M:%S')"

if [[ "$MODE" == "status" ]]; then
  echo "last round : $human_last"
  echo "elapsed    : $(( elapsed / 3600 ))h of ${MIN_INTERVAL_HOURS}h"
  echo "power      : $(pmset -g batt 2>/dev/null | head -1 | sed "s/.*from '//;s/'.*//")"
  echo "round lock : $([[ -d "$LOCK_DIR" ]] && echo held || echo free)"
  discover_roster
  echo "roster     : ${#ACCOUNTS[@]} runnable account(s) (agents/*/ with 'era: 3')"
  [[ "$elapsed" -lt "$need" ]] && echo "verdict    : too soon" || echo "verdict    : due"
  exit 0
fi

if [[ "$elapsed" -lt "$need" && "$MODE" != "force" ]]; then
  # --dry-run means "check everything, run nothing". Exiting here would make it
  # useless for checking the other gates on any day a round already ran.
  if [[ "$MODE" == "dry" ]]; then
    log "dry-run — interval gate WOULD SKIP (${elapsed}s of ${need}s); checking the rest anyway"
  else
    quiet "skip — ${elapsed}s since last round, need ${need}s (last: $human_last)"
    exit 0
  fi
fi

# ── 2. round lock ────────────────────────────────────────────────────────────
# mkdir is atomic; a PID file inside lets a crashed round's lock be reclaimed
# rather than wedging every future firing.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  holder=$(cat "$LOCK_DIR/pid" 2>/dev/null | tr -dc '0-9')
  if [[ -n "$holder" ]] && kill -0 "$holder" 2>/dev/null; then
    quiet "skip — a round is already running (pid $holder)"
    exit 0
  fi
  log "reclaiming a round lock left by dead pid ${holder:-unknown}"
  rm -rf "$LOCK_DIR" && mkdir "$LOCK_DIR" || { log "FAIL — cannot take the round lock"; exit 75; }
fi
echo "$$" > "$LOCK_DIR/pid"
# One empty file per running worker, named by its pid -- which is its
# process-group id once it has called setsid. The worker's own wrapper writes
# it, BEFORE setsid (section 7), so a signal that lands between the fork and
# the setsid still finds the worker; `signal_worker` falls back to the pid
# while the group does not exist yet.
WORKER_DIR="$LOCK_DIR/workers"
mkdir -p "$WORKER_DIR"
pids=()
owns_embedder=0   # section 6 sets it; the signal path reads it

cleanup() { rm -rf "$LOCK_DIR"; }
group_alive() { kill -0 -- "-$1" 2>/dev/null; }
# A registered worker that has not reached its setsid yet has no group.
worker_alive() { group_alive "$1" || kill -0 "$1" 2>/dev/null; }
signal_worker() {                   # signal_worker <SIG> <pid>
  kill "-$1" -- "-$2" 2>/dev/null || kill "-$1" "$2" 2>/dev/null
}
# Lock files whose holder is dead (section 4 says why). Prints the count.
sweep_dead_locks() {
  local f pid n=0
  for f in "$STATE_DIR"/lock_* "$STATE_DIR"/dream_lock_*; do
    [[ -e "$f" ]] || continue
    pid=$(head -1 "$f" 2>/dev/null | tr -dc '0-9')
    if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$f" && n=$(( n + 1 ))
    fi
  done
  echo "$n"
}
# Stop every running worker: TERM each, wait out the grace, KILL what is
# left. The workers run in their own sessions (section 7), so nothing else --
# not launchd, not the terminal -- will ever signal them. The directory is
# re-read on every pass, so a worker that registered after the TERM pass is
# still KILLed at the end.
stop_workers() {
  local f p waited=0 live
  # The per-account pollers first, so none of them logs a TIMEOUT, reaps, or
  # starts anything while the workers below are being stopped.
  for p in ${pids[@]+"${pids[@]}"}; do kill -TERM "$p" 2>/dev/null; done
  for f in "$WORKER_DIR"/*; do
    [[ -e "$f" ]] && signal_worker TERM "$(basename "$f")"
  done
  while :; do
    live=0
    for f in "$WORKER_DIR"/*; do
      [[ -e "$f" ]] && worker_alive "$(basename "$f")" && live=1
    done
    [[ "$live" == "0" || "$waited" -ge "$ACCOUNT_KILL_GRACE" ]] && break
    sleep 1; waited=$(( waited + 1 ))
  done
  for f in "$WORKER_DIR"/*; do
    [[ -e "$f" ]] && signal_worker KILL "$(basename "$f")"
  done
}
# A signal ENDS the round. A trap without `exit` runs and then resumes the
# script: the lock was gone and the next batch started anyway (measured).
# The teardown a normal round does in section 8 happens here too: an
# embedder this round started is stopped, and the stopped workers' locks are
# swept.
on_signal() {                       # on_signal <exit-code> <signal-name>
  trap - TERM INT
  log "round interrupted by SIG$2 — stopping running workers, no further batch"
  stop_workers
  if [[ "$owns_embedder" == "1" ]]; then
    bash "$SCRIPT_DIR/embedder-guard.sh" down >/dev/null 2>&1 && log "embedder stopped"
  fi
  sweep_dead_locks >/dev/null
  exit "$1"
}
trap cleanup EXIT
trap 'on_signal 143 TERM' TERM
trap 'on_signal 130 INT' INT

# ── 3. preconditions ─────────────────────────────────────────────────────────
fail_precondition() { log "skip — $1"; exit 0; }   # exit 0: not an error, just not now

[[ -f "$ROOT_DIR/.env" ]] || fail_precondition "no agent/.env"

# `set -a; . .env` OVERWRITES anything the caller exported, so a one-off
# `SWIL_URL=... bash opportunistic-round.sh` would be silently ignored and the
# run would go to production anyway. This repo has been bitten by that
# precedence before. Snapshot the caller's values, source .env, then put the
# caller's back: explicit beats configured, and a flag you set is a flag that
# takes effect. It is the order `swil_agent/config.py` uses as well (process
# env over agent/.env), so the workers see the URL this script's checks used.
_caller_env=""
for v in SWIL_URL EMBEDDER_URL ROUND_MIN_INTERVAL_HOURS PARALLEL ACCOUNT_TIMEOUT ACCOUNT_KILL_GRACE ALLOW_BATTERY AUTO_COMMIT; do
  [[ -n "${!v:-}" ]] && _caller_env="${_caller_env}${v}=$(printf '%q' "${!v}") "
done
set -a; . "$ROOT_DIR/.env"; set +a
[[ -n "$_caller_env" ]] && eval "export $_caller_env"

# Re-derive the tuning values: .env may have set them, the caller outranks it.
MIN_INTERVAL_HOURS="${ROUND_MIN_INTERVAL_HOURS:-$MIN_INTERVAL_HOURS}"
PARALLEL="${PARALLEL:-5}"
ACCOUNT_TIMEOUT="${ACCOUNT_TIMEOUT:-1800}"
ACCOUNT_KILL_GRACE="${ACCOUNT_KILL_GRACE:-10}"
ALLOW_BATTERY="${ALLOW_BATTERY:-0}"
AUTO_COMMIT="${AUTO_COMMIT:-1}"

[[ -n "${SWIL_URL:-}" ]] || fail_precondition "SWIL_URL unset in agent/.env"

if [[ "$ALLOW_BATTERY" != "1" ]]; then
  pmset -g batt 2>/dev/null | head -1 | grep -q "AC Power" \
    || fail_precondition "on battery (a full round is ~30 min; set ALLOW_BATTERY=1 to override)"
fi

# Network readiness, with retries rather than one probe. This job's most common
# trigger is a wake from sleep, and Wi-Fi takes seconds to re-associate after
# one. A single immediate probe would fail on almost every wake, skip, and then
# wait a full StartInterval -- so the machine being "available" would reliably
# NOT produce a round. Bounded: give up after NET_WAIT_SECS and let the next
# firing try, because a hung driver is worse than a missed slot.
NET_WAIT_SECS="${NET_WAIT_SECS:-90}"
wait_for() {                       # wait_for <label> <url> <accept-any-http>
  local label="$1" url="$2" any="$3" waited=0 code=""
  while :; do
    code=$(curl -s -o /dev/null -m 10 -w "%{http_code}" "$url" 2>/dev/null)
    if [[ "$any" == "any" ]]; then
      [[ -n "$code" && "$code" != "000" ]] && { [[ "$waited" -gt 0 ]] && log "$label reachable after ${waited}s"; return 0; }
    else
      [[ "$code" == "200" ]] && { [[ "$waited" -gt 0 ]] && log "$label up after ${waited}s"; return 0; }
    fi
    [[ "$waited" -ge "$NET_WAIT_SECS" ]] && { echo "$code"; return 1; }
    sleep 10; waited=$(( waited + 10 ))
  done
}

code=$(wait_for "API" "$SWIL_URL/health" "200") \
  || fail_precondition "API not healthy at $SWIL_URL/health after ${NET_WAIT_SECS}s (last ${code:-000})"

# The LLM endpoint decides whether a round can do anything at all. Without it
# every account fails one after another and the round burns every slot
# producing nothing but FAIL lines. 401 counts as reachable -- we are testing the network,
# not the credentials.
code=$(wait_for "Anthropic API" "https://api.anthropic.com/v1/models" "any") \
  || fail_precondition "api.anthropic.com unreachable after ${NET_WAIT_SECS}s (a round with no LLM is one failure per account)"

command -v claude >/dev/null 2>&1 || fail_precondition "claude CLI not on PATH"
command -v uv     >/dev/null 2>&1 || fail_precondition "uv not on PATH"
# Section 7 starts every worker in its own session through perl (macOS ships
# no `setsid` binary); without it a timeout cannot reach the worker's tree.
command -v perl   >/dev/null 2>&1 || fail_precondition "perl not on PATH"

# ── 4. sweep locks whose owner is gone ───────────────────────────────────────
# A worker that had to be SIGKILLed (a timeout past its grace, a killed
# round) never runs its lease release and orphans lock_<name> /
# dream_lock_<name>. Unattended, one orphan silently retires that account from
# every future round, so the sweep is not housekeeping -- it is what keeps the
# roster whole.
swept=$(sweep_dead_locks)
[[ "$swept" -gt 0 ]] && log "swept $swept dead lock file(s)"

# ── 5. roster, derived from the directories ──────────────────────────────────
# Only Era 3 accounts (see discover_roster) are swept; a manual
# `cycle-one.sh <name>` still runs any account directly.
discover_roster
[[ "${#ACCOUNTS[@]}" -gt 0 ]] || fail_precondition "no Era 3 accounts found"

# One id for the whole sweep, exported to every worker; `cycle` falls back to a
# manual id if this account already has a thread under it.
export SWIL_ROUND_ID="$(date -u +%Y%m%dT%H%M%SZ)-r"
round_seed_value=$(round_seed "$SWIL_ROUND_ID")
shuffled=()
while IFS= read -r n; do
  [[ -n "$n" ]] && shuffled+=( "$n" )
done < <(shuffle_roster "$round_seed_value" "${ACCOUNTS[@]}" 2>/dev/null)
if [[ "${#shuffled[@]}" -eq "${#ACCOUNTS[@]}" ]]; then
  ACCOUNTS=( "${shuffled[@]}" )
else
  # A label never stops a round: run in directory order and say so.
  log "WARN roster shuffle failed — running in directory order"
fi
log "round $SWIL_ROUND_ID — seed $round_seed_value, order: ${ACCOUNTS[*]}"

if [[ "$MODE" == "dry" ]]; then
  log "dry-run — every gate passed; would run ${#ACCOUNTS[@]} accounts ${PARALLEL}-way"
  exit 0
fi

# Stamp at START, not at the end. The interval governs CADENCE; if a round dies
# halfway we must not immediately relaunch the roster at a broken environment.
echo "$now_epoch" > "$STAMP"

log "round start — ${#ACCOUNTS[@]} accounts, ${PARALLEL}-way, timeout ${ACCOUNT_TIMEOUT}s/account"

# Housekeeping BEFORE the round, not after: it then runs even when the previous
# round died, and it prunes before this round adds another ~6-55 MB (estimate). Keeping 2
# rounds means the peak is 2 and `--resume` always has something to resume.
# `|| true` on purpose -- a failure to tidy must never be why a round does not
# happen. CHECKPOINT_KEEP=0 disables.
if [[ "${CHECKPOINT_KEEP:-2}" != "0" ]]; then
  python3 "$SCRIPT_DIR/prune-checkpoints.py" --keep "${CHECKPOINT_KEEP:-2}" 2>&1 \
    | while IFS= read -r line; do log "$line"; done || true
fi

# ── 6. embedder ──────────────────────────────────────────────────────────────
# Pre-warm before the fan-out. Each cycle brackets its own ref-counted guard,
# but with PARALLEL processes starting at once they serialise on the guard's
# spinlock waiting for the first one to finish loading a 2.3GB model. The
# round's own `up` here holds one reference for the whole sweep, so every
# cycle's `up`/`down` only moves the count above it and the round's `down`
# in section 8 is the last one -- the one that stops a daemon this round
# started. A daemon already running (launchd, by hand) is external: left alone.
# We hold the round lock, so no other round is running; any non-zero ref count
# is therefore left over from a round that died before its `down`. Left alone it
# never returns to 0 again, so the guard stops stopping the daemon and a 2.3GB
# model stays resident forever. Found exactly that state on 2026-08-20: count=2
# with nothing running.
GUARD_COUNT_FILE="$STATE_DIR/embedder_guard/count"
if [[ -f "$GUARD_COUNT_FILE" ]]; then
  gc=$(tr -dc '0-9' < "$GUARD_COUNT_FILE")
  if [[ -n "$gc" && "$gc" -gt 0 ]]; then
    log "resetting a stale embedder-guard refcount ($gc → 0; no round was running)"
    echo 0 > "$GUARD_COUNT_FILE"
  fi
fi

if ! curl -s -m 3 -o /dev/null "${EMBEDDER_URL:-http://127.0.0.1:7777}/health" 2>/dev/null; then
  if bash "$SCRIPT_DIR/embedder-guard.sh" up >/dev/null 2>&1; then
    owns_embedder=1
    log "embedder started by this round"
  else
    log "WARN embedder would not start — the duplicate guard fails open and post vectors will be missing this round; recover them afterwards with: uv run --project agent swil-agent backfill-post-vectors"
  fi
fi

# ── 7. run ───────────────────────────────────────────────────────────────────
# Every worker starts in its OWN session, so its pid is its process-group id
# and a timeout can signal the whole tree by PGID. macOS ships no `setsid`
# binary; perl's POSIX::setsid then exec keeps the pid, so `$!` IS the group.
# (`set -m` did not do this: the job's group was `run_one`'s subshell, so
# `kill -- -<worker pid>` hit run_one itself, the KILL was never sent and the
# 124 never returned -- measured under /bin/bash 3.2.) Kill by PGID, NEVER by
# pattern: `pkill -f codex` also kills the editor and any MCP server running.
#
# What a TERM reaches: caffeinate, cycle-one.sh, uv and the Python worker. The
# worker's LLM CLI child runs in a session of its own (`llm/runner.py`), so
# the group signal does NOT reach it; the worker's SIGTERM handler
# (SystemExit 143, `cli/app.py`) is what kills that CLI and releases the
# leases -- hence TERM, a grace, and only then KILL. The SIGKILL residual: a
# worker still alive after ACCOUNT_KILL_GRACE dies without that cleanup, so
# its CLI child is orphaned until it exits on its own and its lock files wait
# for the step-4 sweep.
#
# The wrapper registers the worker itself (`$WORKER_DIR/<pid>`) before its
# setsid, so the signal path can never miss one that was forked but not yet
# registered; it refuses to start at all once the round lock is gone.
SETSID_EXEC='use POSIX (); my $d = shift @ARGV; open(my $f, ">", "$d/$$") or die "register $d/$$: $!\n"; close $f; POSIX::setsid() != -1 or die "setsid: $!\n"; exec { $ARGV[0] } @ARGV or die "exec $ARGV[0]: $!\n"'
run_one() {
  local name="$1" rc=0 waited=0 grace=0
  perl -e "$SETSID_EXEC" "$WORKER_DIR" caffeinate -i bash "$SCRIPT_DIR/cycle-one.sh" "$name" \
    >>"$ROOT_DIR/logs/auto-run.log" 2>&1 &
  local pgid=$!
  while kill -0 "$pgid" 2>/dev/null; do
    if [[ "$waited" -ge "$ACCOUNT_TIMEOUT" ]]; then
      if ! kill -TERM -- "-$pgid" 2>/dev/null; then
        # It exited between the poll and the TERM: a finished worker, not a
        # timeout -- report its own exit status.
        wait "$pgid"; rc=$?
        rm -f "$WORKER_DIR/$pgid"
        return "$rc"
      fi
      log "TIMEOUT $name after ${waited}s — TERM pgid $pgid"
      while group_alive "$pgid" && [[ "$grace" -lt "$ACCOUNT_KILL_GRACE" ]]; do
        sleep 1; grace=$(( grace + 1 ))
      done
      if group_alive "$pgid"; then
        log "TIMEOUT $name — pgid $pgid still alive after ${grace}s, KILL"
        kill -KILL -- "-$pgid" 2>/dev/null
      fi
      wait "$pgid" 2>/dev/null
      rm -f "$WORKER_DIR/$pgid"
      return 124
    fi
    sleep 1; waited=$(( waited + 1 ))
  done
  wait "$pgid"; rc=$?
  rm -f "$WORKER_DIR/$pgid"
  return "$rc"
}

ok=0; bad=0; timedout=0
i=0
while [[ "$i" -lt "${#ACCOUNTS[@]}" ]]; do
  batch=()
  for (( j=0; j<PARALLEL && i<${#ACCOUNTS[@]}; j++, i++ )); do batch+=( "${ACCOUNTS[$i]}" ); done
  pids=(); names=()
  for name in "${batch[@]}"; do
    run_one "$name" & pids+=( $! ); names+=( "$name" )
  done
  for k in "${!pids[@]}"; do
    wait "${pids[$k]}"; rc=$?
    case "$rc" in
      0)   ok=$(( ok + 1 )) ;;
      124) timedout=$(( timedout + 1 )) ;;
      *)   bad=$(( bad + 1 )); log "rc=$rc ${names[$k]}" ;;
    esac
  done
  pids=()
done

# ── 8. teardown ──────────────────────────────────────────────────────────────
if [[ "$owns_embedder" == "1" ]]; then
  bash "$SCRIPT_DIR/embedder-guard.sh" down >/dev/null 2>&1 && log "embedder stopped"
fi

# Sweep again: a worker killed this round orphans its locks, and the next
# round is two days away -- long enough to forget why an account went quiet.
sweep_dead_locks >/dev/null

log "round done — ok=$ok failed=$bad timeout=$timedout"

# ── 9. commit the round's output ─────────────────────────────────────────────
# LOCAL COMMIT ONLY, never a push. The round rewrites memory.md and
# personality.md; left uncommitted they pile up until someone reviews fifteen
# rounds at once. A local commit is trivially reversible and reaches no server.
#
# Until agent/archive/era-2 is committed, `git add agent/agents` would stage the
# Era 2 roster's deletions on their own and history would record Era 2 as
# deleted rather than archived. The owner commits the Era 3 changeset first.
if [[ "$AUTO_COMMIT" == "1" ]]; then
  cd "$REPO_DIR" || exit 0
  if ! git ls-files --error-unmatch agent/archive/era-2/boundary.json >/dev/null 2>&1; then
    log "auto-commit skipped: Era 2 archive not committed yet"
  elif [[ -n "$(git status --porcelain -- agent/agents)" ]]; then
    # The pathspec keeps this commit to the round's own output: without it,
    # whatever the owner had staged elsewhere -- a half-done change, a
    # deletion -- went into an unattended, --no-verify commit along with it.
    git add agent/agents
    git -c commit.gpgsign=false commit -q --no-verify -m \
      "chore(agent): unattended round $(date '+%Y-%m-%d %H:%M') — ok=$ok failed=$bad timeout=$timedout" \
      -- agent/agents \
      && log "committed round output (not pushed)"
  fi
fi

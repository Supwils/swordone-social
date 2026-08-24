"""Compose the whole dream path: cooldown, candidate generation, the gate,
and -- when accepted -- the write sequence that archives the old
personality, writes the new one, updates the cooldown markers, and uploads
a snapshot.

Source of truth is `agent/scripts/dream.sh` (read directly; see `dream/
candidate.py`'s and `dream/gate.py`'s module docstrings for why the contract
docs alone are not trusted here) and `agent/scripts/snapshot.sh` for
`build_snapshot_payload` -- both read line-by-line while writing this module,
not assumed from the contract doc's transcription.

WRITE ORDERING IS THE CONTRACT (contract `03` §4, `dream.sh:828-882`), and it
is the reason steps 1-6 below live INSIDE `write_step` rather than being six
separately callable pieces a caller sequences for itself (step 7 is
`snapshot_step`, deliberately outside that atomic group -- see its own
docstring for why a failure there is a WARN, not a rollback):

  1. diff narrative                 -- computed FIRST, using `original` and
                                        `candidate` as the two in-memory
                                        strings they already are at this
                                        point (equivalently: while
                                        personality.md on disk still holds
                                        the OLD text)
  2. archive prepend                -- `persona_source.archive_and_write`
  3. personality.md write              bundles this pair into ONE call, in
                                        that internal order (temp-file swap;
                                        see `persona/source.py`)
  4. `last_dream_<name>` marker      -- `state.record_dream` bundles this
  5. `last_dream_memlines_<name>`       pair into ONE call, in that internal
     marker                             order (`dream/candidate.py`'s
                                        `FilesystemDreamState.record_dream`)
  6. memory.md append                -- AFTER step 5, so the housekeeping
                                        line self-counts toward the NEXT
                                        round's cooldown-override tally
                                        (deliberate; do not reorder --
                                        contract `03` §1.3/§4)
  7. snapshot upload                 -- after personality.md is already
                                        live; a failure here is a WARN and
                                        does NOT roll back the write already
                                        committed in steps 2-3

Two collaborators each bundle two of Bash's seven numbered steps into one
call because they already carry their own correctness invariant about the
pair's internal order (an atomic temp-file swap; two related on-disk
markers) -- see their own docstrings. `write_step`'s job is the ordering
BETWEEN those bundles, not within them. `run_dream`'s own job is the
ordering between the five STEPS (`cooldown_step`, `dream_step`, `gate_step`,
`write_step`, `snapshot_step` -- each separately callable so Task 7's graph
nodes drive the same implementations this path does, ruling R4), and
guarding the whole sequence with
`FileLock(dream_lock_path(...))` so a held lock raises `LockBusy` OUT of this
function (ruling R6) rather than being folded into `DreamResult` -- the
lock's release-on-exception behaviour (a plain `with` block) is what stops
the accepted-dream orphan lock: under Bash, every accepted dream exits 141
right after "snapshot uploaded" (a SIGPIPE inside the echo-chamber detector,
see CLAUDE.md), and because that happens AFTER the `trap ... RETURN EXIT`
line already ran, the lock is still released there -- but a Python exception
anywhere in this sequence, before this function returns, releases the lock
the same way a normal return does, which is the actual fix for that class of
defect once this runtime is live.

Lab-event posting (`_post_agent_event` calls in dream.sh -- 15 call sites
across the dream path) IS implemented, via `_emit` below: `dream/dream`
started/fail/warn/success and `snapshot/snapshot` success/warn, matching
Bash's own summary strings exactly (fix round 1, item 1 -- an initial
version of this module deferred this, reasoning that the seven-step WRITE
ordering contract has no lab-event step in it; the coordinator's counter was
that Python's act path already emits 5 events through `act/executor.py`,
so a silent dream path is an inconsistency within this one plan, not a
deferral, and spec §10 stage 4's cutover criterion -- "every canary dream
terminates with a recorded verdict" -- is written against `/lab`, not a
local log line). `_emit` never lets an events outage change what this
function returns -- see its own docstring -- mirroring `Resources.lab_event`
's existing `except ApiError: return` guarantee with a second, broader net.

Two lab-event details this module does NOT attempt: Bash's per-check
summary/reason SPLIT for structural failures (six different validators, each
putting the dynamic part in a different one of `summary`/`reason` --
`persona/validators.py`'s `ValidationFailure.detail` already gives one
combined string, which every reject event's `summary` carries whole rather
than being pulled apart again here), and the two `echo_flag` events
(`echo/cleared`, `echo/flagged`) -- the first is unreachable without the
second, which is the write side of echo-chamber detection this module does
not implement (see below).

Deliberately NOT implemented here, consistent with CLAUDE.md's own framing
of the feature as "OFF by default" and uncalibrated:

  * Echo-chamber DETECTION -- the write side of contract `03` §4.10
    (embedding an account's last 12 posts, computing pairwise variance,
    writing a NEW `echo_flag_<name>`). `settings.echo_detect` defaults to
    `False` and must not become `True` in this plan (its threshold is
    uncalibrated: measured variance 0.001-0.011 against a shipped 0.04
    would flag every account on every dream, confounding the topic aspect
    of the in-flight drift experiment). Since the feature is inert by
    construction whenever it stays off, and no test in this task's brief
    exercises it, this module wires only the unconditional READ-and-consume
    side (`dream.candidate.read_echo_hint`, called every dream regardless
    of `ECHO_DETECT` -- Bash's own read is not gated either, only the
    write/detection block at the bottom of `dream_one` is). Implementing
    the write side is left to whichever later task actually calibrates
    `ECHO_VARIANCE_THRESHOLD`, so turning it on is a one-place change
    instead of an already-half-built feature nobody remembers is there.
  * `EmbedderGuard.up()`/`.down()` and the "probe `EmbedderClient.health()`
    once per ROUND, not once per dream" ruling (forward requirement to
    tasks 12 AND 13, `progress.md`). Reading `dream.sh` directly confirms
    it never calls `embedder-guard.sh` itself -- `cycle-one.sh` brackets
    ONE ACCOUNT'S act+dream pair with `up`/`down`, and a full ROUND is many
    `cycle-one.sh` processes sharing that ref-counted guard, so "once per
    round" can only mean "once across many `run_dream` calls for different
    accounts", i.e. a concern that belongs to whatever composes multiple
    calls to this function (task 13's CLI), never to a single one of them.
    Nothing here calls the guard or probes embedder health.
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime
from pathlib import Path
from typing import Any, Final, NamedTuple

from swil_agent.api.client import ApiError
from swil_agent.api.dto import LabEvent
from swil_agent.api.resources import Resources, WriteNotVerifiedError
from swil_agent.config import Settings
from swil_agent.dream.candidate import (
    DreamState,
    MissingIdentityBulletError,
    check_cooldown,
    clean_candidate,
    group_memory_digest,
    pin_identity_bullets,
    read_echo_hint,
    render_dream_prompt,
)
from swil_agent.dream.distill import Embedder
from swil_agent.dream.gate import GateOutcome, evaluate_candidate
from swil_agent.embedder.client import EmbedderUnavailable
from swil_agent.llm.base import (
    Backend,
    BackendConfigurationError,
    BackendUnavailableError,
    CompletionRequest,
    Runner,
    complete_text,
)
from swil_agent.locks import FileLock, dream_lock_path
from swil_agent.models import DreamResult, DreamVerdict, DriftMeasurement, Persona
from swil_agent.persona.source import PersonaSource

logger = logging.getLogger(__name__)

_ARCHIVE_TAIL_LINES: Final = 20
_RECENT_MEMORY_LINES: Final = 60
_NARRATIVE_MAX_CHARS: Final = 1500
_GROUP_MEMORY_LIMIT: Final = 30
_EXCERPT_MAX_CHARS: Final = 280

# `dream.sh:105-115`'s `_diff_narrative` system prompt, verbatim (single
# static string across every call, like `candidate.py`'s
# `DREAM_SYSTEM_PROMPT`).
_DIFF_NARRATIVE_SYSTEM_PROMPT: Final = (
    "你在对比同一个虚拟人格的两个版本（做梦前 / 做梦后）。用中文，2~3 句话，"
    "说清楚这次梦把人格往哪个方向塑造了：哪些特质被强化、哪些淡出、有没有新主题冒出来。"
    "只输出这段叙述本身，不要标题、不要任何前后缀。"
)

# `dream.sh:66`'s `ASPECT_PROMPT_VERSION` default, duplicated here rather
# than imported from `dream/gate.py`'s private `_ASPECT_PROMPT_VERSION` --
# the same call `test_gate.py` itself makes ("pinned here as a literal ...
# rather than importing a private name"). This copy feeds only the snapshot
# payload's informational `aspectDrift.promptVersion` field; it plays no
# part in any cache-key match (that match is entirely internal to
# `dream/gate.py` and `dream/distill.py`), so a future bump only needs
# updating in the two places that already duplicate it today.
#
# An `int`, NOT the `str` `dream/gate.py`'s same-named constant is. The two
# copies feed different consumers and the types are load-bearing on both
# sides, which is why unifying them would be the wrong fix:
#   * HERE the value crosses the wire into `aspectDrift.promptVersion`,
#     which `server/src/modules/agents/agents.schemas.ts`'s
#     `aspectDriftIngest` declares as `z.number().int().nonnegative()` with
#     NO `.coerce`. A JSON string fails that validation and the server
#     rejects the WHOLE snapshot ingest -- i.e. every accepted Python dream
#     silently loses its personality snapshot, the exact failure mode
#     already in this project's history ("create-api-key before the first
#     dream or the personality snapshot silently never lands"). Bash sends
#     a JSON number: `dream.sh:769` uses `jq -n --argjson pv`, not `--arg`.
#   * In `dream/gate.py` the value is STRING-CONCATENATED into the anchor
#     aspect cache key (`sha256(anchor):v{N}`, `dream.sh:318`). Changing its
#     type there would be harmless in Python but is exactly the kind of edit
#     that invites a format change, and a changed key invalidates all 23
#     real warm `personality.anchor.aspects.json` files at once (~69 extra
#     `claude` calls to rebuild). It stays a `str` for that reason.
_ASPECT_PROMPT_VERSION: Final = 2

# dream.sh:805's OWN lab-event summary for that same case -- a DIFFERENT,
# past-tense string from its `_log` line one line above (dream.sh:804 uses
# "skipping"; the event uses "skipped"). Both are transcribed verbatim from
# the script, not assumed to be the same string.
_EMBEDDER_UNREACHABLE_EVENT_SUMMARY: Final = "embedder unreachable, skipped drift check"

# Prefix of `dream/gate.py`'s aspect-fallback note. Duplicated rather than
# imported from `analysis.cycle_run` (peers, spec §5.2) or from `gate.py`
# (private). Used to mark `gateStatus=fail_open` on the 2026-08-13 path.
_ASPECT_FALLBACK_PREFIX: Final = "aspect distill/embed failed"


def _gate_status(verdict: DreamVerdict, *, written: bool) -> str:
    """Dream-event copy of the cycle_run card's gateStatus.

    The warn/fail/success events this module posts are the "dream event (if
    one exists)" spec §3 names; the card copies the same string. Fail-open
    is flagged on an accepted ungated write even before `written` is True
    so the embedder-unreachable WARN (posted in `gate_step`, before the
    write) carries the status.
    """
    if not verdict.accepted:
        if verdict.scalar_sim is None and verdict.sims is None:
            return "struct_reject"
        return "drift_reject"
    ungated = verdict.embedder_unreachable or verdict.reason.startswith(_ASPECT_FALLBACK_PREFIX)
    if ungated:
        return "fail_open"
    if written:
        return "accepted"
    return "checked"


# dream.sh:647-648's own log line and lab-event summary for a backend that
# produced nothing -- ONE string used by both, and by `DreamResult.reason`,
# so a caller never has to re-spell it.
_LLM_EMPTY_REASON: Final = "LLM returned empty"

# The calibration series' own event summary (Phase B task 1). Has no Bash
# counterpart -- `dream.sh` never recorded a measurement it did not gate on,
# which is the defect. Consumers should key on the presence of the metrics
# KEYS (`_drift_metrics`'s typed fields), not on this text: reason-string
# matching is the coupling `DreamVerdict.scalar_sim` was added to remove.
_DRIFT_MEASURED_SUMMARY: Final = "drift measured"


def _emit(resources: Resources, username: str, event: LabEvent) -> None:
    """Best-effort observability write -- mirrors `Resources.lab_event`'s
    own guarantee (it already swallows `ApiError` internally, matching
    dream.sh's own unconditional `|| true` at the end of
    `_post_agent_event`, dream.sh:422) with a second, broader safety net
    here: NOTHING this module does in response to a lab event may change
    what `run_dream` returns, even if `resources` is a test double (or a
    future implementation) whose `lab_event` does not honour that guarantee
    on its own -- fix round 1, item 1's explicit proof requirement.
    """
    try:
        resources.lab_event(username, event)
    except Exception:
        logger.debug(
            "lab event failed for %s (%s/%s/%s): outcome unaffected",
            username,
            event.type,
            event.phase,
            event.outcome,
        )


def _drift_metrics(measurement: DriftMeasurement, settings: Settings) -> dict[str, Any]:
    """The calibration series' wire payload: the measurement, FLATTENED.

    `agentEventIngest` declares `metrics` as
    `z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]))`
    (`server/src/modules/agents/agents.schemas.ts:59`) -- checked against
    the schema by running it, not read off a description of it. A nested
    object or an array fails that union and zod rejects the WHOLE event, so
    the three aspect similarities are three top-level keys here rather than
    one `aspects` object. (`_drift_fail_metrics` below matches this same
    flattening -- Phase B task 1b -- and reuses these four key spellings for
    the quantities the two functions share; see its own docstring for the
    defect that made flattening it, too, necessary.)

    `None` survives to the wire as JSON `null` and is the point: it records
    "not computed" as a distinguishable value. A `0.0` here would be a
    fabricated "maximally drifted" sample.

    `driftMode` is one key more than the plan's own list. It is cheap and
    it is the difference between a row that can be interpreted years later
    and one that needs the deploy history to read -- `aspectValues` is
    `None` both when the mode never asks for aspects and when the aspect
    pipeline failed, and only the mode separates the two.

    THE FOUR THRESHOLDS RIDE ALONG (2026-08-20 -- the drift-countdown plan's
    task 1), and they come from `settings`, never from a literal here. The
    gate rejects a dream when a similarity falls under a threshold, and the
    similarity's distance from a FIXED anchor only grows, so the series
    recorded above is a countdown to a permanent rejection -- but only if
    the reader knows which line it is counting down TO. A consumer that
    keeps its own copy of the numbers silently reinterprets every historical
    point the moment somebody retunes `agent/.env`: the same 0.71 that was
    inside the band in July reads as outside it in September, and nothing
    anywhere says the ruler moved. Recorded BESIDE the measurement, the
    point stays readable forever.

    This is the only copy that is allowed to move. `config.py:34-37` holds
    the values; `client/src/features/lab/AgentDetail.tsx:22` holds a third,
    hardcoded one that a later task of the same plan deletes in favour of
    these keys. Do not add a fourth -- in particular, the server must NOT
    re-declare them: it reads them off the event.

    CHANGE POINT. Every `drift measured` event filed before 2026-08-20
    carries no `thScalar`/`thValues`/`thStyle`/`thTopic` at all. A consumer
    fitting a projection over that stretch has no threshold to project
    against and must SAY so rather than substituting today's value, which
    would be exactly the silent reinterpretation the previous paragraph is
    about.
    """
    aspects = measurement.aspects
    return {
        "anchorSim": measurement.anchor_sim,
        "stepSim": measurement.step_sim,
        "aspectValues": None if aspects is None else aspects.values,
        "aspectStyle": None if aspects is None else aspects.style,
        "aspectTopic": None if aspects is None else aspects.topic,
        "embedderOk": measurement.embedder_ok,
        "driftMode": measurement.mode,
        "thScalar": settings.drift_threshold,
        "thValues": settings.drift_threshold_values,
        "thStyle": settings.drift_threshold_style,
        "thTopic": settings.drift_threshold_topic,
    }


def _drift_fail_metrics(verdict: DreamVerdict, settings: Settings) -> dict[str, Any]:
    """The `fail_metrics` payload attached to a drift REJECTION's lab event
    -- aspect-shaped when the gate produced per-aspect similarities (fires
    whenever the aspect computation succeeded, regardless of which mode
    ultimately decided -- see the per-aspect branch below), else
    `{similarity, drift}` built from `verdict.scalar_sim` -- a TYPED field on
    `DreamVerdict` (fix round 2, task 12), not text pulled back out of
    `reason` by pattern-matching. An earlier version of this function
    regex-matched the number out of `dream/gate.py`'s `_scalar_decision`
    reason string; that coupling meant a harmless-looking reword of that
    message (e.g. `sim=` -> `similarity=`) would silently empty this
    function's output with no test failure anywhere -- a lab event missing
    its numbers looks identical to one that was never going to have any.
    `scalar_sim` closes that gap: `gate.py` populates it whenever the scalar
    embed pair succeeded, on BOTH the accept and reject paths, and leaves it
    `None` -- not `0.0` -- when the embedder could not be reached, so this
    function tells "no value" apart from "value 0.0" by construction rather
    than by regex-match-or-not.

    A STRUCTURAL failure's `verdict.sims` AND `verdict.scalar_sim` are both
    `None` (`dream/gate.py` returns immediately after `validate_candidate`
    fails, before ever computing a similarity) -- so both branches fall
    through to `{}` for a structural failure without this function needing
    to know which kind of failure it is looking at, matching Bash's own "no
    metrics" behaviour for those six checks.

    FLATTENED (Phase B task 1b). This function used to return `{"aspects":
    {"values": ..., "style": ..., "topic": ...}, "breached": [...], "mode":
    ...}` for the per-aspect branch -- a nested object and an array.
    `agentEventIngest.metrics` is `z.record(z.union([z.string(), z.number(),
    z.boolean(), z.null()]))` (`server/src/modules/agents/
    agents.schemas.ts:59`), which neither shape satisfies, so zod rejected
    the WHOLE event and `validate(agentEventIngest, 'body')`
    (`agents.routes.ts:98`) 400'd it. `DRIFT_MODE=aspect` has been the live
    default since 2026-07-03, so every aspect-mode rejection from that date
    forward never reached `/lab` -- the exact defect `_drift_metrics` above
    was written not to repeat, and this function now matches its spelling
    (`aspectValues`/`aspectStyle`/`aspectTopic`/`driftMode`) for the three
    quantities they share, rather than inventing a second convention for the
    same numbers. `breached` has no counterpart in `_drift_metrics` (that
    function never gates), so it keeps its own name; the list is flattened
    to a single comma-joined string -- aspect names are drawn from the fixed
    set `{values, style, topic}`, none of which can ever contain a comma, so
    the join is lossless: it can be split back into the exact original list
    with `s.split(",") if s else []` -- the guard matters because a plain
    `.split(",")` on the empty case returns `['']`, not `[]`. An empty
    `breached` joins to `""`, distinct from any real one-element string
    (`"values"`, `"style"`, or `"topic"`), so "nothing breached" is never
    confused with "one aspect breached" on the wire.

    The scalar-mode branch (`{similarity, drift}`) and the structural
    branch (`{}`) were already flat before this task and are unchanged --
    both were already legal against `agentEventIngest.metrics`, so widening
    them here would be a rewrite of a working branch, not a fix.
    """
    if verdict.sims is not None:
        return {
            "aspectValues": verdict.sims.values,
            "aspectStyle": verdict.sims.style,
            "aspectTopic": verdict.sims.topic,
            "breached": ",".join(verdict.breached),
            "driftMode": settings.drift_mode,
        }
    if verdict.scalar_sim is None:
        return {}
    return {"similarity": verdict.scalar_sim, "drift": round(1 - verdict.scalar_sim, 4)}


def build_snapshot_payload(
    *,
    text: str,
    directory: Path,
    agent_root: Path,
    embedding: list[float],
    captured_at: datetime,
    narrative: str = "",
    aspect_drift: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """`snapshot.sh`'s own POST body (contract `03` §5, `snapshot.sh:127-145`).

    `excerpt` slices `text` by CHARACTER, not byte: Python string slicing is
    already codepoint-based, which is exactly what dodges the bug
    `snapshot.sh`'s own comment documents -- its first attempt used
    `head -c 280`, which split a multibyte CJK character and crashed the
    downstream `jq --arg` under `set -e`.

    `captured_at` must already be a UTC-valued datetime (the caller decides
    what moment this represents -- production passes `datetime.now(UTC)`);
    this function does not convert, only formats, matching `date -u
    '+%Y-%m-%dT%H:%M:%SZ'`.

    `archivePath` is computed relative to `agent_root`, matching
    `realpath --relative-to="$ROOT_DIR" "$DIR"` + `/personality.md`
    (`snapshot.sh:115`) -- no filesystem access, since neither `directory`
    nor `agent_root` need to exist on disk for this to be well-defined.
    """
    payload: dict[str, Any] = {
        "contentHash": hashlib.sha256(text.encode()).hexdigest(),
        "snapshotType": "dream",
        "capturedAt": captured_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "archivePath": (directory / "personality.md").relative_to(agent_root).as_posix(),
        "excerpt": text.replace("\n", " ")[:_EXCERPT_MAX_CHARS],
        "embedding": list(embedding),
    }
    if narrative:
        payload["diffNarrative"] = narrative
    if aspect_drift is not None:
        payload["aspectDrift"] = aspect_drift
    return payload


def _generate_candidate(
    backend: Backend, system_prompt: str, user_prompt: str, model: str | None
) -> str:
    """The dream-rewrite LLM call itself (contract `03` §3): one attempt, no
    retry (unlike the aspect distiller's three-attempt loop in
    `dream/distill.py`). A `BackendUnavailableError` -- raised by every
    concrete `Backend` when its underlying process produced nothing,
    including on a timeout that left the output file empty
    (`dream.sh:635-639`'s watchdog falls through to the same "empty output"
    check rather than returning early) -- degrades to `""` here, which
    `clean_candidate` then carries through to the same `FAIL ... LLM
    returned empty` outcome Bash logs at `dream.sh:646-650`.
    """
    try:
        return complete_text(
            backend, CompletionRequest(system=system_prompt, user=user_prompt, model=model)
        )
    except BackendUnavailableError:
        return ""


def _diff_narrative(
    old_text: str, new_text: str, backend: Backend, *, model: str | None = None
) -> str:
    """Contract `03` §4.1 (`dream.sh:105-115`, `_diff_narrative`): a
    best-effort 2-3 sentence Chinese summary of what this dream changed,
    generated by the SAME backend the account dreams under.

    Bash calls `llm_text "$backend" "" "$sys" "$usr"` -- a LITERAL empty
    model argument, meaning "the CLI's own default". Claude/codex/deepseek
    have one. Cursor does not: an empty `--model` silently becomes `auto`,
    which this runtime refuses. For `backend.name == "cursor"` the empty
    argument therefore means "use the account's pinned model", not "omit
    the flag". Measured 2026-08-23: three cursor accounts (gewu/houniao/
    shiyi) posted, then the cycle died here with rc=75 because
    `BackendConfigurationError` was not in the degrade set.

    A failure here never aborts the dream (Bash's own `|| echo ''`).
    """
    user_prompt = f"【旧版 personality】\n{old_text}\n\n【新版 personality】\n{new_text}"
    req_model = model if getattr(backend, "name", None) == "cursor" else None
    try:
        raw = complete_text(
            backend,
            CompletionRequest(
                system=_DIFF_NARRATIVE_SYSTEM_PROMPT, user=user_prompt, model=req_model
            ),
        )
    except BackendUnavailableError:
        return ""
    except BackendConfigurationError as exc:
        logger.warning("WARN diff-narrative skipped (%s): %s", getattr(backend, "name", "?"), exc)
        return ""
    return " ".join(raw.split())[:_NARRATIVE_MAX_CHARS]


def _group_memory(resources: Resources, name: str) -> str:
    """Contract `03` §2.2: `_group_memory_digest` degrades to `""` on any
    HTTP failure (`dream.sh:368`'s `|| echo ''`). Bash also guards on
    `api_key.txt` existing before making the call at all -- an artifact of
    Bash's own per-call curl authentication with no equivalent here:
    `resources` is already the account's authenticated client (composed by
    the caller), so there is nothing further to check.

    `limit=30, unread_only=False` matches dream.sh's own raw
    `GET .../notifications?limit=30` call (no `unreadOnly` parameter at
    all) -- a DIFFERENT call site from `swil.sh`'s own notification read
    (`Resources.notifications`'s default `unread_only=True`, contract `01`
    §2j, used by `act/context.py`'s `build_context`).
    """
    try:
        notifications = resources.notifications(limit=_GROUP_MEMORY_LIMIT, unread_only=False)
    except ApiError:
        notifications = []
    return group_memory_digest(notifications)


def _read_memory_archive_tail(directory: Path) -> str:
    """`tail -20 memory.archive.md`, or `""` if that file does not exist --
    `render_dream_prompt` itself substitutes the "(尚无历史归档)" literal for
    an empty `archive_tail` (`dream/candidate.py`), so this function need
    not know about that placeholder at all.
    """
    path = directory / "memory.archive.md"
    if not path.is_file():
        return ""
    lines = path.read_text(encoding="utf-8").splitlines()
    return "\n".join(lines[-_ARCHIVE_TAIL_LINES:])


def _aspect_drift_payload(verdict: DreamVerdict, settings: Settings) -> dict[str, Any] | None:
    """The `aspectDrift` block `dream.sh:816-818` builds and forwards to
    `snapshot.sh` via `ASPECT_DRIFT_OVERRIDE` -- `None` (which
    `build_snapshot_payload` then omits entirely) whenever the gate never
    produced per-aspect similarities, matching Bash's own empty
    `aspect_drift_json` default (scalar mode, or aspect/shadow mode with a
    failed distill/embed -- `dream/gate.py`'s `evaluate_candidate` already
    leaves `DreamVerdict.sims` as `None` in exactly those cases).
    """
    if verdict.sims is None:
        return None
    return {
        "mode": settings.drift_mode,
        "promptVersion": _ASPECT_PROMPT_VERSION,
        "values": verdict.sims.values,
        "style": verdict.sims.style,
        "topic": verdict.sims.topic,
        "breached": verdict.breached,
    }


class CooldownStep(NamedTuple):
    """The scheduling gate's decision, plus the ONE read of `memory.md` the
    rest of the round is built on.

    `memory_text` and `memory_lines` come back from here rather than being
    re-read downstream because both are load-bearing and both must describe
    the file as it stood BEFORE this dream appends its own "personality
    consolidated" line:

      * `memory_lines` is what `write_step` records into
        `last_dream_memlines_<name>` (contract `03` §4 steps 4-5). Counting
        it after the append records 101 where Bash records 100, and the next
        round's cooldown-override tally is off by one forever after --
        pinned by `test_the_memlines_marker_is_written_before_the_memory_
        append`.
      * `memory_text` is the same text `dream_step` slices its last-60-line
        prompt block out of, so the count that decided the cooldown and the
        memory the model is shown can never come from two different reads.
    """

    proceed: bool
    reason: str
    memory_text: str
    memory_lines: int


def cooldown_step(
    *,
    persona: Persona,
    persona_source: PersonaSource,
    state: DreamState,
    settings: Settings,
    now: datetime,
    auto: bool = False,
) -> CooldownStep:
    """Step 1 of the dream path: read `memory.md`, then decide whether this
    account may dream at all (`dream.sh:479-510`).

    Both of Bash's log lines live HERE, not in the caller: the SKIP line is
    the only record that a round happened and declined, and the "cooldown
    override" line is the only record that the 12h floor was deliberately
    broken. A second caller that branched on `proceed` without logging would
    make an account's absence from `dream.log` mean two different things.

    `auto=False` ("force" mode) always proceeds -- `check_cooldown` returns
    before `state` is consulted at all, so a forced dream costs no marker
    reads.
    """
    name = persona.directory.name
    memory_text = persona_source.read_memory(name)
    memory_lines = memory_text.count("\n")

    cooldown = check_cooldown(
        state,
        name,
        auto=auto,
        memory_lines=memory_lines,
        now=int(now.timestamp()),
        cooldown_hours=settings.dream_cooldown_hours,
        min_new_memories=settings.dream_min_new_memories,
    )
    if not cooldown.proceed:
        logger.info("SKIP %s — %s", name, cooldown.reason)
    elif cooldown.reason:
        logger.info("%s — %s", name, cooldown.reason)
    return CooldownStep(
        proceed=cooldown.proceed,
        reason=cooldown.reason,
        memory_text=memory_text,
        memory_lines=memory_lines,
    )


class DreamStep(NamedTuple):
    """The rewrite candidate, or the reason there is none.

    `failure_reason` is `None` whenever `candidate` is non-empty, and
    otherwise carries Bash's own `LLM returned empty` string -- the single
    way this step can fail. Carrying it here rather than leaving each caller
    to re-derive it from `candidate`'s emptiness keeps the reason that
    reaches `DreamResult` identical to the one already logged and posted as
    a lab event by this step.
    """

    candidate: str
    failure_reason: str | None


def dream_step(
    *,
    persona: Persona,
    resources: Resources,
    backend: Backend,
    agent_root: Path,
    memory_text: str,
) -> DreamStep:
    """Step 2 of the dream path: announce the dream, assemble its four
    prompt blocks, and make the ONE rewrite call (`dream.sh:512-661`).

    The `dream/dream/started` lab event is the FIRST thing this step does,
    which is what puts it where Bash has it -- after the cooldown gate
    (`dream.sh:513`, inside the block a SKIP already returned from) and
    before the `GET /notifications` the group-memory digest makes. A caller
    that emitted it itself could not preserve both halves of that at once;
    here the account cannot generate a candidate without first being on
    record as having started.

    Everything else in this step is READ, with one exception:
    `read_echo_hint` CONSUMES the `echo_flag_<name>` marker (deletes it --
    "only nudge once per dream", `dream.sh:533`). That is why this step is
    not re-runnable and why the cooldown gate has to have decided before it
    is entered: a second call spends the flag on a prompt nobody asked for.

    `memory_text` is the caller's, not a fresh read -- see `CooldownStep`
    for why the round reads `memory.md` exactly once.
    """
    name = persona.directory.name
    _emit(
        resources,
        persona.username,
        LabEvent(type="dream", phase="dream", outcome="started", summary="dream started"),
    )

    recent_memory = "\n".join(memory_text.splitlines()[-_RECENT_MEMORY_LINES:])
    archive_tail = _read_memory_archive_tail(persona.directory)
    group_memory = _group_memory(resources, name)
    echo_hint = read_echo_hint(agent_root / ".agent-state", name)

    system_prompt, user_prompt = render_dream_prompt(
        persona_text=persona.raw,
        recent_memory=recent_memory,
        archive_tail=archive_tail,
        group_memory=group_memory,
        echo_hint=echo_hint,
    )

    raw = _generate_candidate(backend, system_prompt, user_prompt, persona.model)
    candidate_text = clean_candidate(raw)
    if not candidate_text:
        logger.warning("FAIL %s — %s", name, _LLM_EMPTY_REASON)
        _emit(
            resources,
            persona.username,
            LabEvent(type="dream", phase="dream", outcome="fail", summary=_LLM_EMPTY_REASON),
        )
        return DreamStep(candidate="", failure_reason=_LLM_EMPTY_REASON)
    try:
        candidate_text = pin_identity_bullets(persona.raw, candidate_text)
    except MissingIdentityBulletError as exc:
        reason = str(exc)
        logger.warning("FAIL %s — %s", name, reason)
        _emit(
            resources,
            persona.username,
            LabEvent(type="dream", phase="dream", outcome="fail", summary=reason),
        )
        return DreamStep(candidate="", failure_reason=reason)
    return DreamStep(candidate=candidate_text, failure_reason=None)


def gate_step(
    *,
    persona: Persona,
    candidate_text: str,
    resources: Resources,
    embedder: Embedder,
    runner: Runner,
    settings: Settings,
) -> GateOutcome:
    """Step 3 of the dream path: the constitution layer -- six structural
    validators, then the drift gate (`dream.sh:668-826`) -- plus the lab
    events that are the only external record of what it measured and what
    it decided: ONE always, and at most TWO in any single call.

    PURE with respect to the account's files: nothing here writes anything
    (the candidate lives in memory, not in a temp file as under Bash), which
    is what makes it safe for a Task 7 node to run before any write node
    exists.

    Three events are DEFINED here and at most two FIRE: the measurement is
    unconditional, and `warn` requires `accepted` while `fail` requires the
    negation, so they are mutually exclusive by construction. All of them
    belong to this step because all of them describe the GATE, not the
    round:

      * `success` + `summary="drift measured"` -- ALWAYS, whatever the
        verdict, including a structural rejection that never reached an
        embed. This is the calibration series (Phase B task 1, spec §8.1):
        before it, a dream contributed a data point only by being
        ACCEPTED, so the recorded distribution described the gate's own
        survivors. Emitted from HERE, not from `run_dream`, because
        `run_dream` is not the only caller -- `graph/nodes.py`'s gate node
        calls this function directly and is the deployed runtime since the
        Stage-5 cutover, so a measurement posted by the composition would
        be missing from every real round.
      * `warn` -- accepted, but `embedder_unreachable`: the drift check
        could not run at all and the dream landed UNGATED. Losing this
        event is worse than the outage it reports, since a fail-open is
        otherwise indistinguishable from a healthy accept.
      * `fail` + `_drift_fail_metrics` -- rejected. `run_dream` no longer
        needs to know how to spell either.

    The measurement event is posted FIRST, before the verdict's own event,
    so a timeline read top-down shows the numbers and then what was decided
    with them. It is a separate event rather than extra keys on the
    verdict's event for two reasons: a structural rejection and an accepted
    dream have no event in common to hang it on, and `agentEventIngest`
    caps `metrics` at flat scalars (see `_drift_metrics`), which the
    existing rejection payload already violates.

    The reason a caller must NOT re-derive the accept decision from
    `verdict.reason`: `dream/gate.py` COMPOSES that string, and in the
    deployed `DRIFT_MODE=aspect` a non-empty `aspect_note` prefix is
    routine. The typed fields (`accepted`, `embedder_unreachable`) are the
    contract; the text is for operators.

    `persona.raw` is the ORIGINAL side of every comparison -- the text the
    prompt was built from, not a fresh read of `personality.md`. Re-reading
    would compare the candidate against whatever is on disk NOW, which for a
    concurrent Bash round is a different document.
    """
    outcome = evaluate_candidate(
        persona.raw,
        candidate_text,
        directory=persona.directory,
        embedder=embedder,
        runner=runner,
        settings=settings,
    )
    verdict = outcome.verdict
    _emit(
        resources,
        persona.username,
        LabEvent(
            type="dream",
            phase="dream",
            outcome="success",
            summary=_DRIFT_MEASURED_SUMMARY,
            metrics=_drift_metrics(outcome.measurement, settings),
        ),
    )
    # `DreamVerdict.embedder_unreachable`, NOT a comparison against
    # `verdict.reason` -- see this function's docstring, and
    # `test_embedder_unreachable_still_warns_in_the_deployed_aspect_mode`
    # for the case an `==` silently stopped matching. Bash fires this event
    # on the condition itself (dream.sh:804-805), not on the text of its own
    # log line.
    if verdict.accepted and verdict.embedder_unreachable:
        _emit(
            resources,
            persona.username,
            LabEvent(
                type="dream",
                phase="dream",
                outcome="warn",
                summary=_EMBEDDER_UNREACHABLE_EVENT_SUMMARY,
                metrics={"gateStatus": "fail_open"},
            ),
        )

    if not verdict.accepted:
        logger.warning("FAIL %s — %s; keeping original", persona.directory.name, verdict.reason)
        fail_metrics = _drift_fail_metrics(verdict, settings)
        fail_metrics["gateStatus"] = _gate_status(verdict, written=False)
        _emit(
            resources,
            persona.username,
            LabEvent(
                type="dream",
                phase="dream",
                outcome="fail",
                summary=verdict.reason,
                metrics=fail_metrics,
            ),
        )
    return outcome


class WriteStep(NamedTuple):
    """Whether `personality.md` actually changed, and the diff narrative
    computed while it had not yet.

    `written` is the round's single source of truth for "the candidate is
    now this account's personality": every later step keys off it rather
    than re-deriving the same answer from `verdict.accepted` (see
    `snapshot_step`, whose upload is only meaningful once the file it
    describes is live).
    """

    written: bool
    narrative: str


def write_step(
    *,
    persona: Persona,
    persona_source: PersonaSource,
    state: DreamState,
    resources: Resources,
    backend: Backend,
    verdict: DreamVerdict,
    candidate_text: str,
    memory_lines: int,
    now: datetime,
) -> WriteStep:
    """Step 4 of the dream path: steps 1-6 of the write-ordering contract
    (module docstring; contract `03` §4, `dream.sh:828-859`), in that order,
    then the DONE line and the `dream/dream/success` event.

    `verdict.accepted` GATES the whole step, and the guard lives here rather
    than only in whichever caller sequences the steps. This function is
    where a rejected candidate would become the account's personality --
    silently defeating the constitution layer, with `personality.archive.md`
    already prepended and the old text recoverable only by hand. `run_dream`
    THREADS the verdict in and branches on the `written` flag that comes
    back, so the guard is the load-bearing one; a Task 7 node that reached
    this function with a rejected verdict (an unconditional edge out of the
    gate node) writes nothing instead of writing the wrong thing.

    Two orderings inside are contracts rather than preferences:

      * The diff narrative is computed FIRST, from `persona.raw` and
        `candidate_text` as the two in-memory strings they already are --
        equivalently, while `personality.md` on disk still holds the OLD
        text (`dream.sh:829-832`'s own comment says exactly that).
      * `record_dream`'s memlines marker is written BEFORE `append_memory`,
        so the "personality consolidated" housekeeping line self-counts
        toward the NEXT round's cooldown-override tally.

    `memory_lines` is the caller's pre-append count for that same reason:
    counting here, after the append, records 101 where Bash records 100.
    """
    if not verdict.accepted:
        return WriteStep(written=False, narrative="")

    name = persona.directory.name
    narrative = _diff_narrative(persona.raw, candidate_text, backend, model=persona.model)  # 1
    persona_source.archive_and_write(name, candidate_text, now)  # 2 + 3
    state.record_dream(name, at=int(now.timestamp()), memlines=memory_lines)  # 4 + 5
    persona_source.append_memory(name, f"{now:%Y-%m-%d} | dream | personality consolidated")  # 6
    logger.info("DONE %s dreamed — personality updated (old → personality.archive.md)", name)
    _emit(
        resources,
        persona.username,
        LabEvent(
            type="dream",
            phase="dream",
            outcome="success",
            summary="personality updated",
            metrics={"gateStatus": _gate_status(verdict, written=True)},
        ),
    )
    return WriteStep(written=True, narrative=narrative)


class SnapshotStep(NamedTuple):
    """Whether the personality snapshot reached the server, and if not, the
    failure's OWN message.

    `ok=False, reason=None` is the "no snapshot was owed" shape a skipped
    step returns -- the same pair `DreamResult`'s defaults already carry for
    every round that never reached an accepted write, so a caller cannot
    accidentally report a rejected dream as having uploaded one.
    """

    ok: bool
    reason: str | None


def snapshot_step(
    *,
    persona: Persona,
    resources: Resources,
    embedder: Embedder,
    settings: Settings,
    verdict: DreamVerdict,
    candidate_text: str,
    narrative: str,
    agent_root: Path,
    captured_at: datetime,
    written: bool,
) -> SnapshotStep:
    """Step 5 of the dream path: step 7 of the write-ordering contract --
    embed the new personality and POST it to `/agents/.../snapshots`
    (`dream.sh:861-882`, `snapshot.sh`).

    `written` GATES the step, and the guard lives here rather than only in
    the caller. A snapshot is a CLAIM about what this account's
    `personality.md` now says: uploading one for a candidate that the gate
    rejected puts a row in `personalitysnapshots` for a document that never
    existed, and `/lab`'s drift trajectory -- the in-flight experiment's
    primary readout -- would then plot versions the roster never ran under.
    `run_dream` threads `write.written` in rather than branching above the
    step, so the guard is load-bearing (removing it reddens the oracle's
    `test_a_rejected_dream_touches_nothing`).

    NEVER a rollback (contract `03` §4.9): by the time this runs,
    `personality.md` has already been swapped and archived. Every failure
    mode -- embedder down (`EmbedderUnavailable`), server refusing the write
    (`WriteNotVerifiedError`), HTTP failure (`ApiError`) -- is a WARN plus a
    `snapshot/snapshot/warn` lab event, and the round still reports
    `accepted=True`.

    `reason` is the exception's OWN message, never a hardcoded guess: the
    2026-07-31 incident cost two investigations chasing a healthy server and
    a healthy embedder while the real cause ("no api_key.txt for <name>")
    was already printed one line above.
    """
    if not written:
        return SnapshotStep(ok=False, reason=None)

    name = persona.directory.name
    try:
        vector = embedder.embed([candidate_text])[0]
        payload = build_snapshot_payload(
            text=candidate_text,
            directory=persona.directory,
            agent_root=agent_root,
            embedding=vector,
            captured_at=captured_at,
            narrative=narrative,
            aspect_drift=_aspect_drift_payload(verdict, settings),
        )
        resources.create_snapshot(persona.username, payload)  # 7
    except (EmbedderUnavailable, WriteNotVerifiedError, ApiError) as exc:
        reason = str(exc)
        logger.warning("WARN %s — snapshot upload failed: %s", name, reason)
        _emit(
            resources,
            persona.username,
            LabEvent(
                type="snapshot",
                phase="snapshot",
                outcome="warn",
                summary="snapshot upload failed",
                reason=reason,
            ),
        )
        return SnapshotStep(ok=False, reason=reason)

    logger.info("%s — snapshot uploaded", name)
    _emit(
        resources,
        persona.username,
        LabEvent(
            type="snapshot",
            phase="snapshot",
            outcome="success",
            summary="snapshot uploaded",
        ),
    )
    return SnapshotStep(ok=True, reason=None)


def run_dream(
    *,
    persona: Persona,
    persona_source: PersonaSource,
    resources: Resources,
    backend: Backend,
    runner: Runner,
    embedder: Embedder,
    state: DreamState,
    settings: Settings,
    agent_root: Path,
    now: datetime,
    captured_at: datetime,
    auto: bool = False,
) -> DreamResult:
    """One dream round: cooldown -> candidate -> gate -> (on accept) the
    seven-step write sequence, with lab events posted at each terminal
    (and one non-terminal: the embedder-unreachable WARN) point along the
    way via `_emit`. See the module docstring for the ordering contract and
    the two pieces (echo-chamber detection's write side, embedder-guard
    probing) deliberately left to a later task.

    Sequence, as the five separately-callable steps this function is now
    the composition of:

      1. Acquire `FileLock(dream_lock_path(agent_root, name))` around
         EVERYTHING. Ruling R6: a held lock raises `LockBusy` OUT of this
         function -- "there was no round at all" is a different question
         from "what did this round decide", and `DreamResult` only answers
         the second. A plain `with` block is also the fix for the orphan
         dream lock: any exception between here and the return releases it,
         where Bash's accepted dreams exit 141 and leak theirs.
      2. `cooldown_step` -- the one `memory.md` read, its line count, and
         the auto-mode cooldown gate. `proceed=False` returns
         `proceeded=False` with nothing else populated.
      3. `dream_step` -- the `started` event, the four prompt blocks, the
         rewrite call. A `failure_reason` (only ever "LLM returned empty")
         returns `proceeded=True, accepted=False`.
      4. `gate_step` -- validators + drift, the calibration measurement
         it records on every path, and the gate's own events: the
         `drift measured` one ALWAYS, plus at most one of `warn`
         (accepted but ungated) / `fail` (rejected).
      5. `write_step` -- steps 1-6 of the write contract, gated on
         `verdict.accepted` INSIDE the step.
      6. `snapshot_step` -- step 7, gated on `written` INSIDE the step.
      7. Assemble the `DreamResult`.

    The gate's rejection is NOT an early return above steps 5-6: `verdict`
    and `written` are THREADED into them and this function branches on the
    `written` flag that comes back. Both spellings produce the identical
    `DreamResult` -- a rejected `write_step` is `(False, "")` and a skipped
    `snapshot_step` is `(False, None)`, which are `DreamResult`'s own
    defaults for a round that wrote nothing -- but only this one puts each
    guard where its write is. That matters because `run_dream` is not the
    only caller: Task 7's graph nodes call these same functions, and an
    unconditional edge out of a gate node would otherwise land a rejected
    candidate on disk and publish a snapshot of a personality that never
    existed. This is the same shape `run_act` uses for `dry_run`
    (`act/round.py`), and for the same reason (ruling R4): a block of logic
    that exists only inside the composition is a block the graph has to
    copy, and a copy is free to drift.

    Account/file resolution (`dir` not found, no `personality.md`, no
    `memory.md` -- contract `03` §1.2) is NOT this function's job:
    `persona: Persona` arriving here already implies a successful
    `load_persona`, mirroring `run_act`'s own `persona: Persona` parameter
    (task 7, `act/round.py`). The caller (the CLI, task 13) is where "no
    such account" becomes an exit code.

    `now` is a naive local wall-clock moment, matching the convention
    `GitPersonaSource.archive_and_write`'s own `when: datetime` parameter
    already established (`test_persona_source.py` drives it with plain
    `datetime(...)` literals, no tzinfo) -- it feeds the archive stamp, the
    memory.md date line, and (via `int(now.timestamp())`) the epoch marker,
    exactly the three things Bash's own (local-time) `date` calls feed.
    `captured_at` is the SEPARATE UTC moment the snapshot's `capturedAt`
    field needs -- Bash reads these from two independent `date`/`date -u`
    invocations too, so two independently-suppliable parameters here is
    more faithful than deriving one from the other via an environment-
    dependent timezone conversion.
    """
    name = persona.directory.name
    with FileLock(dream_lock_path(agent_root, name)):
        cooldown = cooldown_step(
            persona=persona,
            persona_source=persona_source,
            state=state,
            settings=settings,
            now=now,
            auto=auto,
        )
        if not cooldown.proceed:
            return DreamResult(proceeded=False, reason=cooldown.reason)
        memory_lines = cooldown.memory_lines

        dreamt = dream_step(
            persona=persona,
            resources=resources,
            backend=backend,
            agent_root=agent_root,
            memory_text=cooldown.memory_text,
        )
        if dreamt.failure_reason is not None:
            return DreamResult(proceeded=True, reason=dreamt.failure_reason)
        candidate_text = dreamt.candidate

        gate = gate_step(
            persona=persona,
            candidate_text=candidate_text,
            resources=resources,
            embedder=embedder,
            runner=runner,
            settings=settings,
        )
        verdict = gate.verdict
        # ── Accept sequence -- write ordering is the contract (module docstring) ──
        # `verdict` is THREADED into the step that writes rather than
        # short-circuited above it: the reject branch below reads
        # `write.written`, so `write_step`'s own guard is the load-bearing
        # one and a caller that is not `run_dream` cannot get a rejected
        # candidate onto disk.
        write = write_step(
            persona=persona,
            persona_source=persona_source,
            state=state,
            resources=resources,
            backend=backend,
            verdict=verdict,
            candidate_text=candidate_text,
            memory_lines=memory_lines,
            now=now,
        )
        snapshot = snapshot_step(
            persona=persona,
            resources=resources,
            embedder=embedder,
            settings=settings,
            verdict=verdict,
            candidate_text=candidate_text,
            narrative=write.narrative,
            agent_root=agent_root,
            captured_at=captured_at,
            written=write.written,
        )
        if not write.written:
            return DreamResult(proceeded=True, reason=verdict.reason, verdict=verdict)

        # Echo-chamber DETECTION stops here -- see the module docstring's
        # "deliberately NOT implemented" note. The read/consume side
        # (`read_echo_hint`) already ran inside `dream_step`, unconditionally.

        return DreamResult(
            proceeded=True,
            accepted=True,
            reason=verdict.reason,
            verdict=verdict,
            narrative=write.narrative,
            recorded_memlines=memory_lines,
            snapshot_ok=snapshot.ok,
            snapshot_reason=snapshot.reason,
        )

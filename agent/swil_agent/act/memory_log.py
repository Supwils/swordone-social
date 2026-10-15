"""The act path's `memory.md` line: format one note per landed write, append
it, and fire its `memory/memory/success` lab event.

Moved out of `act/round.py` verbatim (S3 §9); `execute_step` there is the
only caller, and imports `_write_memory_line` by name so a test that patches
`act.round._write_memory_line` still patches the name the caller looks up.
"""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path
from typing import Final

from swil_agent.api.dto import LabEvent
from swil_agent.api.resources import Resources
from swil_agent.llm.extract import collapse_doubled_text
from swil_agent.models import Action, ActionResult

_MEMORY_PREVIEW_CAP = 80
_WHITESPACE_RUN = re.compile(r" {2,}")

# The exact `detail` string `act/executor.py`'s `_execute_comment` sets on the
# parent-unusable-retry-succeeded path. Duplicated here (not imported) because
# it is a private literal inside that module's function body, not a name --
# see `_memory_note`'s docstring for what this sentinel is for and the test
# that would catch the two strings drifting apart.
_PARENT_UNUSABLE_DETAIL = "parent unusable — posted top-level"


def _memory_field(raw: str | None) -> str:
    """Whitespace-clean one field for a memory.md note, WITHOUT the
    doubled-text collapse (contract `02` §4.2, cross-cutting facts).

    Mirrors `tr -d '\\n' | sed 's/  */ /g'` then `.strip()`, exactly like
    `act/execution_outcome.py`'s private `_clean` applies to the copy of the field it
    sends to the API -- reproduced here rather than imported because the
    memory line is built from the ORIGINAL `Action` the guardrails approved,
    independently of whatever the executor already did with its own copy of
    the same field on the way to the wire.
    """
    text = (raw or "").replace("\n", "")
    return _WHITESPACE_RUN.sub(" ", text).strip()


def _memory_text(raw: str | None) -> str:
    """`_memory_field` plus the doubled-text collapse -- for the fields
    `act/executor.py`'s module docstring names as eligible for it:
    `post.text`, `comment.text`, `echo.text`, `dm.text`. NEVER `imageTopic`
    or a username (fix round 1, task-7 review item 3: an earlier version of
    this module ran `image_topic` through this same collapsing function,
    which could make the `[img:...]` memory-line tag disagree with the
    topic string actually used to fetch the image -- a byte-compatibility
    break in shared on-disk state that only fires on an exact-duplicate
    topic string >= 40 chars, which is why it went unnoticed at first.
    `_memory_field` above is the non-collapsing variant now used for
    `image_topic`. `test_memory_note_collapses_...` pins this against the
    exact shape the brief specifies; a divergence between this and
    `execution_outcome._clean` would show up as the two modules' tests disagreeing
    on the same input, not as a shared import silently drifting.
    """
    return collapse_doubled_text(_memory_field(raw))


def _memory_username(raw: str | None) -> str:
    """`tr -d '@[:space:]'` -- mirrors `act/execution_outcome.py`'s private
    `_clean_username`, for the same reason `_memory_text` mirrors `_clean`."""
    return re.sub(r"[@\s]", "", raw or "")


def _memory_note(action: Action, result: ActionResult) -> str | None:
    """The per-kind memory note text (contract `02` §4.2), or `None` when no
    memory.md line should be written at all.

    Gated on `result.call_succeeded`, NOT on `result.landed` (ruling R19): a
    line is written only for a write that actually happened (contract `02`
    §4.1). For every kind but `follow` the two are equal.

    A `follow` that 409s ("already following", the common outcome) still
    counts as landed -- it is not a failed round -- but the write did not
    succeed, so it records nothing. `memory.md` is the dream's input AND the
    unit `DREAM_MIN_NEW_MEMORIES=8` counts, so a spurious line per
    repeat-follow would shift what every later dream reads and make dreams
    fire earlier.

    The gate here is only half the fix, and on its own it was inert (ruling
    R20). `call_succeeded` is `False` only on `_execute_follow`'s EXCEPT
    branch, and `Resources.follow` used to swallow the 409 before it could
    get there -- so the common "already following" outcome still took the
    success path and still wrote its line. That swallow is gone; the 409 now
    propagates like every other write failure, which is what makes this gate
    reachable at all. Driven end-to-end over a real 409 in
    `test_an_already_following_409_warns_and_writes_no_memory_line`, not
    through a fake whose `follow()` re-raises whatever it is handed.

    `nothing` never gets a line (contract `02` §4.1).
    """
    if not result.call_succeeded or action.kind == "nothing":
        return None

    if action.kind == "post":
        text = _memory_text(action.text)
        # image_topic never goes through the doubled-text collapse (fix
        # round 1, item 3) -- _memory_field, not _memory_text.
        topic = _memory_field(action.image_topic)
        img_tag = f"[img:{topic}] " if topic else ""
        return f"post | id={result.resource_id} | {img_tag}{text[:_MEMORY_PREVIEW_CAP]}"
    elif action.kind == "comment":
        text = _memory_text(action.text)
        # The retry-succeeded-top-level path (contract 02 §2.2) writes NO
        # parentId at all. `result.detail` is the
        # only signal left, after the fact, that this was that path.
        parent_tag = ""
        if action.parent_id and result.detail != _PARENT_UNUSABLE_DETAIL:
            parent_tag = f" parentId={action.parent_id}"
        return (
            f"comment | postId={action.post_id} commentId={result.resource_id}"
            f"{parent_tag} | {text[:_MEMORY_PREVIEW_CAP]}"
        )
    elif action.kind == "like":
        return f"like | postId={action.post_id}"
    elif action.kind == "follow":
        return f"follow | @{_memory_username(action.username)}"
    elif action.kind == "echo":
        text = _memory_text(action.text)
        quote_tag = f" | {text[:_MEMORY_PREVIEW_CAP]}" if text else ""
        return f"echo | id={result.resource_id} echoOf={action.post_id}{quote_tag}"
    elif action.kind == "dm":
        # `ActionResult` carries the conversation id in its own field.
        text = _memory_text(action.text)
        username = _memory_username(action.username)
        return (
            f"dm | to={username} conversationId={result.conversation_id} | "
            f"{text[:_MEMORY_PREVIEW_CAP]}"
        )
    else:
        # ActionKind is a closed 7-member Literal and `nothing` is handled by
        # the early return above, so every remaining member is covered by a
        # branch above -- this is unreachable for a validly constructed
        # Action, exactly like the equivalent branch in
        # act/executor.py:execute_action.
        raise AssertionError(  # pragma: no cover
            f"unhandled action kind for memory note: {action.kind!r}"
        )


# `_remember`'s own whitelist. A note whose leading verb is not
# one of these emits `action=""` -- which `LabEvent.to_wire` then OMITS from
# the body entirely, so `/lab` records the event with no action facet rather
# than with a made-up one. `echo` and `dm` are deliberately ABSENT: Bash's
# whitelist does not contain them either, so their memory events carry no
# action. Transcribed verbatim; do not "complete" it.
_MEMORY_EVENT_ACTIONS: Final = frozenset(
    {"post", "comment", "like", "follow", "unfollow", "delete", "nothing"}
)

# The first `id=`, `postId=` or `commentId=` followed by 24 hex characters.
# Case-sensitive and unanchored, exactly as `grep -E` is: the
# `conversationId=` in a `dm` note does NOT match (`Id` != `id`), so a dm's
# memory event carries no targetId -- checked against the real note shapes,
# not assumed.
_MEMORY_TARGET_RE: Final = re.compile(r"(?:id|postId|commentId)=([a-f0-9]{24})")


def _flatten_note(note: str) -> str:
    r"""`_remember`'s own normalisation of its argument:
    `tr '\n' ' '` then `sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//'`.

    A RAW docstring on purpose: both of those are shell escapes, and in a
    normal docstring `\n` becomes a real newline and `\+` raises a
    SyntaxWarning -- i.e. the transcription stops being a transcription.

    Applied ONCE, to the value that feeds both the memory.md line and the
    lab event's `summary`, because Bash derives both from the same `$note`
    variable. Every component `_memory_note` assembles is already cleaned by
    `_memory_text`, so in practice this is a no-op today -- it exists so the
    two consumers cannot drift apart if a future note shape is not.
    """
    return re.sub(r"\s+", " ", note.replace("\n", " ")).strip(" ")


def _memory_event(note: str) -> LabEvent:
    """The SECOND lab event fired for every memory line, independent of the `cycle/act/*` event
    `act/executor.py` already emits per action.

    So one successful `post` produces TWO POSTs to
    `/agents/{username}/events` -- `cycle/act/success` and `memory/memory/success`
    (ruling R21); `/lab`'s memory surfaces read the second.

    Field placement: `type, phase, outcome, action, summary, reason,
    target_id, metrics`, with `reason` empty and `metrics` `"{}"`. The
    summary is the WHOLE flattened note -- uncapped, unlike the act events'
    200-char cap.
    """
    verb = note.split("|", 1)[0].strip()
    match = _MEMORY_TARGET_RE.search(note)
    return LabEvent(
        type="memory",
        phase="memory",
        outcome="success",
        action=verb if verb in _MEMORY_EVENT_ACTIONS else None,
        summary=note,
        reason=None,
        target_id=match.group(1) if match else None,
    )


def _write_memory_line(
    directory: Path,
    action: Action,
    result: ActionResult,
    *,
    now: datetime,
    resources: Resources,
    username: str,
) -> None:
    """Append one line to `<directory>/memory.md` AND fire the
    `memory/memory/success` lab event, matching `_remember()`
    in both halves and in that ORDER.

    The on-disk line is byte-for-byte `_remember`'s (contract `02` §4.2):
    `<YYYY-MM-DD> | <note>`. `directory` is `persona.directory` -- the same
    folder `resolve_agent_dir` returns and Bash calls `agent_dir` -- so this
    reads and writes the identical file a live Bash round would.

    ORDER IS THE CONTRACT: the file append happens BEFORE the
    event, so an events outage still leaves the memory
    line on disk -- and memory.md, not `/lab`, is what the next dream reads.
    The event itself cannot fail the round in either runtime: Bash ends
    `_lab_event`'s curl with `|| true` and
    `Resources.lab_event` documents the same guarantee ("this never
    raises"). No extra try/except is added here on purpose -- one would
    imply this module distrusts that contract, and would also hide a fake
    that breaks it.

    Real file I/O, performed directly rather than behind an injected seam:
    `FileLock` (Task 2) already established this module family's precedent
    of touching the filesystem for Bash-compatible on-disk state, and
    `memory.md` is exactly that. `username` is the `Username` bullet (whom
    the event is filed under), NOT the directory name -- the same
    distinction `execute_action` already draws.
    """
    note = _memory_note(action, result)
    if note is None:
        return
    note = _flatten_note(note)
    line = f"{now.strftime('%Y-%m-%d')} | {note}\n"
    with (directory / "memory.md").open("a", encoding="utf-8") as handle:
        handle.write(line)
    resources.lab_event(username, _memory_event(note))

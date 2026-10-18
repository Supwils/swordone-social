"""The dream: cooldown, one LLM call for a new 最近 list, the write, the snapshot.

The four steps are separately callable; their one composition is the phase
graph (`graph/nodes_dream.py`), which both the `dream` command (`Phases.DREAM`) and
the `cycle` command run (S3 §4). Each write step guards itself (`recent is
None` -> nothing written; nothing written -> no snapshot), so a mis-wired
caller cannot write a failed dream.

Locking: `write_recent` takes no lock of its own. Every write here must run
under `dream_lock_<name>`: `graph/run.py`'s `run_graph` holds that path as a
`RunLease` for the whole `dream` or `cycle` run.

Lab events never change what a step returns: `Resources.lab_event` never
raises, and logs a WARNING when the server refuses one.
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime
from pathlib import Path
from typing import Any, Final, NamedTuple, Protocol

from swil_agent.api.client import ApiError
from swil_agent.api.dto import (
    EXCERPT_MAX_UNITS,
    REASON_MAX_UNITS,
    SUMMARY_MAX_UNITS,
    LabEvent,
    cap_utf16,
)
from swil_agent.api.resources import Resources, WriteNotVerifiedError
from swil_agent.config import Settings
from swil_agent.dream.candidate import (
    DREAM_MEMORY_NOTE,
    DreamState,
    check_cooldown,
    group_memory_digest,
    parse_recent,
)
from swil_agent.embedder.client import EmbedderUnavailable
from swil_agent.llm.complete import complete_text
from swil_agent.llm.errors import BackendUnavailableError
from swil_agent.llm.protocol import Backend
from swil_agent.llm.runner import CompletionRequest
from swil_agent.models import Persona, PromptVersion
from swil_agent.persona.format import PersonaDoc, PersonaFormatError, clamp_recent, prompt_text
from swil_agent.persona.source import PersonaSource
from swil_agent.prompts import dream_prompt

logger = logging.getLogger(__name__)

_MEMORY_TAIL_LINES: Final = 30
_GROUP_MEMORY_LIMIT: Final = 30
_EXCERPT_MAX_CHARS: Final = 280

LLM_EMPTY_REASON: Final = "LLM returned empty"
UNPARSEABLE_REASON: Final = "unparseable dream output"


class Embedder(Protocol):
    def embed(self, texts: list[str]) -> list[list[float]]: ...


def _dream_event(outcome: str, summary: str) -> LabEvent:
    return LabEvent(type="dream", phase="dream", outcome=outcome, summary=summary)


def snapshot_content(persona: Persona, recent: list[str]) -> str:
    """What a dream snapshot embeds: card + the new 最近, never the frontmatter,
    so the model label never enters a vector. Equal to `prompt_text` of the
    file `write_recent` produces from the same list."""
    return prompt_text(PersonaDoc(meta={}, card=persona.card, recent=clamp_recent(recent)))


def build_snapshot_payload(
    *,
    text: str,
    directory: Path,
    agent_root: Path,
    embedding: list[float],
    captured_at: datetime,
) -> dict[str, Any]:
    """The `POST /agents/:username/snapshots` body for `text`.

    `excerpt` is sliced by code point, so a CJK character is never split,
    then capped to the server's 320 UTF-16 units (an emoji counts two).
    `captured_at` must already be UTC.
    """
    return {
        "contentHash": hashlib.sha256(text.encode()).hexdigest(),
        "snapshotType": "dream",
        "capturedAt": captured_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "archivePath": (directory / "personality.md").relative_to(agent_root).as_posix(),
        "excerpt": cap_utf16(text.replace("\n", " ")[:_EXCERPT_MAX_CHARS], EXCERPT_MAX_UNITS),
        "embedding": list(embedding),
    }


def memory_tail(memory_text: str) -> str:
    """The part of `memory.md` a dream reads: its last 30 lines."""
    return "\n".join(memory_text.splitlines()[-_MEMORY_TAIL_LINES:])


def read_group_memory(resources: Resources) -> str:
    """The group-interaction digest a dream reads (one notifications read,
    read and unread alike); an unreachable API reads as no interaction."""
    try:
        notifications = resources.notifications(limit=_GROUP_MEMORY_LIMIT, unread_only=False)
    except ApiError:
        notifications = []
    return group_memory_digest(notifications)


class CooldownStep(NamedTuple):
    """The cooldown decision plus the one read of `memory.md` the dream uses."""

    proceed: bool
    reason: str
    memory_text: str


def cooldown_step(
    *,
    persona: Persona,
    persona_source: PersonaSource,
    state: DreamState,
    settings: Settings,
    now: datetime,
    auto: bool = False,
) -> CooldownStep:
    """Read `memory.md` and decide whether this account may dream now. Logs
    the SKIP line and the override line here, so every caller logs them."""
    name = persona.directory.name
    memory_text = persona_source.read_memory(name)
    cooldown = check_cooldown(
        state,
        name,
        auto=auto,
        memory_text=memory_text,
        now=now,
        cooldown_hours=settings.dream_cooldown_hours,
        min_new_memories=settings.dream_min_new_memories,
    )
    if not cooldown.proceed:
        logger.info("SKIP %s — %s", name, cooldown.reason)
    elif cooldown.reason:
        logger.info("%s — %s", name, cooldown.reason)
    return CooldownStep(proceed=cooldown.proceed, reason=cooldown.reason, memory_text=memory_text)


class DreamStep(NamedTuple):
    """The new (clamped) 最近 list, or the reason there is none.

    `prompt_chars` is the prompt's size, set whenever the call was made."""

    recent: list[str] | None
    failure_reason: str | None
    prompt_chars: dict[str, int] | None = None


class DreamReply(NamedTuple):
    """One dream call's (clamped) 最近 list, or why there is none."""

    recent: list[str] | None
    failure_reason: str | None


def dream_reply(backend: Backend, request: CompletionRequest) -> DreamReply:
    """Make the one dream call and parse it; no other I/O, no event.

    A silent backend or a blank reply is `LLM_EMPTY_REASON`; a reply with no
    usable list, or one whose items are all blank, is `UNPARSEABLE_REASON`.
    """
    try:
        raw = complete_text(backend, request)
    except BackendUnavailableError:
        raw = ""
    if not raw.strip():
        return DreamReply(recent=None, failure_reason=LLM_EMPTY_REASON)
    parsed = parse_recent(raw)
    recent = list(clamp_recent(parsed)) if parsed is not None else []
    if not recent:  # a list of blanks clamps to nothing: still unparseable
        return DreamReply(recent=None, failure_reason=UNPARSEABLE_REASON)
    return DreamReply(recent=recent, failure_reason=None)


def _fail(
    resources: Resources, persona: Persona, reason: str, chars: dict[str, int] | None = None
) -> DreamStep:
    logger.warning("FAIL %s — %s", persona.directory.name, reason)
    resources.lab_event(persona.username, _dream_event("fail", reason))
    return DreamStep(recent=None, failure_reason=reason, prompt_chars=chars)


def dream_step(
    *,
    persona: Persona,
    resources: Resources,
    backend: Backend,
    memory_text: str,
    version: PromptVersion = "v1",
) -> DreamStep:
    """Announce the dream, make the one LLM call, parse the reply.

    Reads only: nothing on disk changes here. An empty reply, one with no
    usable list, or one whose items are all blank is a `dream`/`fail` event
    and no list.
    """
    resources.lab_event(persona.username, _dream_event("started", "dream started"))
    prompt = dream_prompt(
        version,
        persona,
        memory_tail=memory_tail(memory_text),
        group_memory=read_group_memory(resources),
    )
    reply = dream_reply(backend, prompt.request)
    if reply.recent is None:
        return _fail(resources, persona, reply.failure_reason or UNPARSEABLE_REASON, prompt.chars)
    return DreamStep(recent=reply.recent, failure_reason=None, prompt_chars=prompt.chars)


class WriteStep(NamedTuple):
    """Whether `personality.md` changed, and if a list was refused, why."""

    written: bool
    reason: str | None = None


def write_step(
    *,
    persona: Persona,
    persona_source: PersonaSource,
    state: DreamState,
    resources: Resources,
    recent: list[str] | None,
    now: datetime,
) -> WriteStep:
    """Write the new 最近 list, then record the dream (marker + memory line).

    `recent is None` writes nothing. `write_recent` archives the old file
    before swapping in the new one and refuses (writing nothing) a file that
    is no longer a valid persona or would exceed the size limit -- that is a
    `dream`/`fail` event, not an exception. Caller must hold
    `dream_lock_<name>` (module docstring).
    """
    if recent is None:
        return WriteStep(written=False)

    name = persona.directory.name
    try:
        persona_source.write_recent(name, recent, now)
    except PersonaFormatError as exc:
        reason = str(exc)
        logger.warning("FAIL %s — %s; keeping original", name, reason)
        resources.lab_event(
            persona.username, _dream_event("fail", cap_utf16(reason, SUMMARY_MAX_UNITS))
        )
        return WriteStep(written=False, reason=reason)
    state.record_dream(name, at=int(now.timestamp()))
    persona_source.append_memory(name, f"{now:%Y-%m-%d} | {DREAM_MEMORY_NOTE}")
    logger.info("DONE %s dreamed — 最近 updated (old → personality.archive.md)", name)
    resources.lab_event(persona.username, _dream_event("success", "personality updated"))
    return WriteStep(written=True)


class SnapshotStep(NamedTuple):
    """Whether the snapshot reached the server, and if not, the failure's own
    message. `(False, None)` means no snapshot was owed."""

    ok: bool
    reason: str | None


def snapshot_step(
    *,
    persona: Persona,
    resources: Resources,
    embedder: Embedder,
    agent_root: Path,
    captured_at: datetime,
    recent: list[str] | None,
    written: bool,
) -> SnapshotStep:
    """Embed `snapshot_content` and POST it as a `dream` snapshot.

    Runs only when the write happened. Never a rollback: an embedder outage
    or a refused upload is a WARN and a `snapshot`/`warn` event carrying the
    exception's own message.
    """
    if not written or recent is None:
        return SnapshotStep(ok=False, reason=None)

    name = persona.directory.name
    content = snapshot_content(persona, recent)
    try:
        vector = embedder.embed([content])[0]
        payload = build_snapshot_payload(
            text=content,
            directory=persona.directory,
            agent_root=agent_root,
            embedding=vector,
            captured_at=captured_at,
        )
        resources.create_snapshot(persona.username, payload)
    except (EmbedderUnavailable, WriteNotVerifiedError, ApiError) as exc:
        reason = str(exc)
        logger.warning("WARN %s — snapshot upload failed: %s", name, reason)
        resources.lab_event(
            persona.username,
            LabEvent(
                type="snapshot",
                phase="snapshot",
                outcome="warn",
                summary="snapshot upload failed",
                # `str(exc)` is unbounded (an `ApiError` alone renders up to
                # 310 chars): uncapped, a long refusal 400s this very event.
                reason=cap_utf16(reason, REASON_MAX_UNITS),
            ),
        )
        return SnapshotStep(ok=False, reason=reason)

    logger.info("%s — snapshot uploaded", name)
    resources.lab_event(
        persona.username,
        LabEvent(type="snapshot", phase="snapshot", outcome="success", summary="snapshot uploaded"),
    )
    return SnapshotStep(ok=True, reason=None)

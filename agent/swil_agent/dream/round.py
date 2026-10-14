"""The dream: cooldown, one LLM call for a new 最近 list, the write, the snapshot.

The four steps are separately callable so the cycle graph's nodes
(`graph/nodes.py`) and `run_dream` (the `dream` command) run the same code.
Each write step guards itself (`recent is None` -> nothing written; nothing
written -> no snapshot), so a mis-wired caller cannot write a failed dream.

Locking: `write_recent` takes no lock of its own. Every write here must run
under `dream_lock_<name>`: `run_dream` takes it as a `FileLock` around the
whole sequence, and `graph/cycle.py`'s `run_cycle` holds the same path as a
`RunLease` for the whole cycle.

Lab events never change what a step returns (`_emit`).
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime
from pathlib import Path
from typing import Any, Final, NamedTuple, Protocol

from swil_agent.api.client import ApiError
from swil_agent.api.dto import LabEvent
from swil_agent.api.resources import Resources, WriteNotVerifiedError
from swil_agent.config import Settings
from swil_agent.dream.candidate import (
    DREAM_MEMORY_NOTE,
    DreamState,
    build_dream_prompt,
    check_cooldown,
    group_memory_digest,
    parse_recent,
)
from swil_agent.embedder.client import EmbedderUnavailable
from swil_agent.llm.base import Backend, BackendUnavailableError, complete_text
from swil_agent.locks import FileLock, dream_lock_path
from swil_agent.models import DreamResult, Persona
from swil_agent.persona.format import PersonaDoc, PersonaFormatError, clamp_recent, prompt_text
from swil_agent.persona.source import PersonaSource

logger = logging.getLogger(__name__)

_MEMORY_TAIL_LINES: Final = 30
_GROUP_MEMORY_LIMIT: Final = 30
_EXCERPT_MAX_CHARS: Final = 280

LLM_EMPTY_REASON: Final = "LLM returned empty"
UNPARSEABLE_REASON: Final = "unparseable dream output"


class Embedder(Protocol):
    def embed(self, texts: list[str]) -> list[list[float]]: ...


def _emit(resources: Resources, username: str, event: LabEvent) -> None:
    """Best-effort observability write: an events outage never changes the
    dream's outcome."""
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

    `excerpt` is sliced by code point, so a CJK character is never split.
    `captured_at` must already be UTC.
    """
    return {
        "contentHash": hashlib.sha256(text.encode()).hexdigest(),
        "snapshotType": "dream",
        "capturedAt": captured_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "archivePath": (directory / "personality.md").relative_to(agent_root).as_posix(),
        "excerpt": text.replace("\n", " ")[:_EXCERPT_MAX_CHARS],
        "embedding": list(embedding),
    }


def _group_memory(resources: Resources) -> str:
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
    """The new (clamped) 最近 list, or the reason there is none."""

    recent: list[str] | None
    failure_reason: str | None


def _fail(resources: Resources, persona: Persona, reason: str) -> DreamStep:
    logger.warning("FAIL %s — %s", persona.directory.name, reason)
    _emit(resources, persona.username, _dream_event("fail", reason))
    return DreamStep(recent=None, failure_reason=reason)


def dream_step(
    *,
    persona: Persona,
    resources: Resources,
    backend: Backend,
    memory_text: str,
) -> DreamStep:
    """Announce the dream, make the one LLM call, parse the reply.

    Reads only: nothing on disk changes here. An empty reply, one with no
    usable list, or one whose items are all blank is a `dream`/`fail` event
    and no list.
    """
    _emit(resources, persona.username, _dream_event("started", "dream started"))
    memory_tail = "\n".join(memory_text.splitlines()[-_MEMORY_TAIL_LINES:])
    request = build_dream_prompt(
        persona, memory_tail=memory_tail, group_memory=_group_memory(resources)
    )
    try:
        raw = complete_text(backend, request)
    except BackendUnavailableError:
        raw = ""
    if not raw.strip():
        return _fail(resources, persona, LLM_EMPTY_REASON)
    parsed = parse_recent(raw)
    if parsed is None:
        return _fail(resources, persona, UNPARSEABLE_REASON)
    recent = list(clamp_recent(parsed))
    if not recent:  # a list of blanks clamps to nothing: still unparseable
        return _fail(resources, persona, UNPARSEABLE_REASON)
    return DreamStep(recent=recent, failure_reason=None)


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
        _emit(resources, persona.username, _dream_event("fail", reason[:500]))
        return WriteStep(written=False, reason=reason)
    state.record_dream(name, at=int(now.timestamp()))
    persona_source.append_memory(name, f"{now:%Y-%m-%d} | {DREAM_MEMORY_NOTE}")
    logger.info("DONE %s dreamed — 最近 updated (old → personality.archive.md)", name)
    _emit(resources, persona.username, _dream_event("success", "personality updated"))
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
        LabEvent(type="snapshot", phase="snapshot", outcome="success", summary="snapshot uploaded"),
    )
    return SnapshotStep(ok=True, reason=None)


def run_dream(
    *,
    persona: Persona,
    persona_source: PersonaSource,
    resources: Resources,
    backend: Backend,
    embedder: Embedder,
    state: DreamState,
    settings: Settings,
    agent_root: Path,
    now: datetime,
    captured_at: datetime,
    auto: bool = False,
) -> DreamResult:
    """One dream for one account, under `dream_lock_<name>`.

    A held lock raises `LockBusy` out of this function; any exception
    releases the lock. `now` is naive local time (archive stamp, memory line
    date, cooldown marker); `captured_at` is the snapshot's UTC moment.
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

        dreamt = dream_step(
            persona=persona,
            resources=resources,
            backend=backend,
            memory_text=cooldown.memory_text,
        )
        write = write_step(
            persona=persona,
            persona_source=persona_source,
            state=state,
            resources=resources,
            recent=dreamt.recent,
            now=now,
        )
        snapshot = snapshot_step(
            persona=persona,
            resources=resources,
            embedder=embedder,
            agent_root=agent_root,
            captured_at=captured_at,
            recent=dreamt.recent,
            written=write.written,
        )
        if not write.written:
            return DreamResult(proceeded=True, reason=dreamt.failure_reason or write.reason or "")
        return DreamResult(
            proceeded=True,
            accepted=True,
            recent=dreamt.recent,
            snapshot_ok=snapshot.ok,
            snapshot_reason=snapshot.reason,
        )

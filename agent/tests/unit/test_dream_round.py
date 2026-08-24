"""Tests for `swil_agent.dream.round` (task 12) -- the composition of the
whole dream path: cooldown, candidate generation, the gate, and, on accept,
the seven-step write sequence (contract `03` §4) that archives the old
personality, writes the new one, updates the cooldown markers, appends a
memory.md line, and uploads a snapshot.

Ordering is observed through fakes (`FakePersonaSource`, `FakeState`,
`FakeResources` all threading one shared `order` list, plus `TwoCallBackend`
distinguishing the diff-narrative call by position), never through a
`recorder=` parameter on `run_dream` itself -- ruling R8 (task-12-brief.md /
progress.md). "A rejected dream touches nothing" and the two snapshot-failure
tests use the REAL `GitPersonaSource` against a `tmp_path` roster instead,
so they can assert on real bytes on disk, not merely on a fake's call log.
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import UTC, datetime
from pathlib import Path

import pytest

from swil_agent.api.client import ApiError
from swil_agent.api.resources import WriteNotVerifiedError
from swil_agent.config import Settings
from swil_agent.dream.candidate import clean_candidate
from swil_agent.dream.distill import anchor_cache_key
from swil_agent.dream.gate import _ASPECT_PROMPT_VERSION as _GATE_PROMPT_VERSION
from swil_agent.dream.round import _diff_narrative, build_snapshot_payload, run_dream
from swil_agent.llm.base import (
    BackendConfigurationError,
    BackendUnavailableError,
    CursorCLIBackend,
)
from swil_agent.locks import LockBusy, dream_lock_path
from swil_agent.models import AspectSims, AspectVectors, Persona
from swil_agent.persona.source import GitPersonaSource

from ._runners import (
    ExplodingBackend,
    FakeEmbedder,
    FakePersonaSource,
    FakeResources,
    FakeState,
    RecordingRunner,
    SilentBackend,
    TwoCallBackend,
)

NOW = datetime(2026, 8, 17, 10, 0, 0)
CAPTURED_AT = datetime(2026, 8, 17, 10, 0, 0, tzinfo=UTC)

ORIGINAL = """# 测试

## 身份
- **Username:** zenith
- **Display Name:** 测试
- **Headline:** AI Agent
- **Bio:** 一句话
- **Follow Topics:** alpha,beta,gamma

- **AI Backend:** claude

## 发帖节律
- 每次触发有 60% 概率选择 post
"""


# What `dream/drift.py`'s `resolve_anchor_text` returns for an account whose
# only personality file is `personality.md` (branch 3): `dream.sh` reads it
# as `$(cat "$dir/personality.md")` and `$( )` strips the trailing newline,
# so the anchor cache key is keyed on the STRIPPED text. Seeding a cache HIT
# with the unstripped `ORIGINAL` silently produces a MISS instead.
RESOLVED_ANCHOR = ORIGINAL.rstrip("\n")


def _valid_candidate(bio: str = "改写过的一句话") -> str:
    return ORIGINAL.replace("一句话", bio)


def _bad_username_candidate() -> str:
    """Dropped Follow Topics -- identity copy-back (spec §12) restores a
    mangled Username, so that is no longer a structural reject."""
    return ORIGINAL.replace("- **Follow Topics:** alpha,beta,gamma", "- **Follow Topics:** alpha")


def _write_account(
    tmp_path: Path, *, memory_text: str = "2026-08-01 | act | did a thing\n"
) -> Path:
    directory = tmp_path / "agents" / "zenith"
    directory.mkdir(parents=True)
    (directory / "personality.md").write_text(ORIGINAL, encoding="utf-8")
    (directory / "memory.md").write_text(memory_text, encoding="utf-8")
    return directory


def _persona(directory: Path, *, model: str | None = None) -> Persona:
    return Persona(
        username="zenith",
        directory=directory,
        backend="claude",
        model=model,
        rhythm_text="60% 概率选择 post",
        raw=ORIGINAL,
    )


def _write_anchor_cache(directory: Path, *, anchor_text: str, vectors: AspectVectors) -> None:
    """Pre-seeds a cache HIT for `dream.distill.anchor_aspects`, same on-disk
    shape `test_gate.py`'s own `_write_anchor_cache` builds -- see that
    file's docstring for why (it lets a test control the anchor side's
    vectors without spending an embedder/runner call on it)."""
    key = anchor_cache_key(anchor_text, prompt_version="2")
    payload = {
        "key": key,
        "cards": {"values": "unused-on-cache-hit", "style": "unused-on-cache-hit", "topic": "x"},
        "vectors": {"values": vectors.values, "style": vectors.style, "topic": vectors.topic},
    }
    (directory / "personality.anchor.aspects.json").write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8"
    )


def _run(
    tmp_path: Path,
    directory: Path,
    *,
    persona: Persona | None = None,
    persona_source: object | None = None,
    resources: FakeResources | None = None,
    backend: object | None = None,
    runner: object | None = None,
    embedder: FakeEmbedder | None = None,
    state: FakeState | None = None,
    settings: Settings | None = None,
    auto: bool = False,
):
    return run_dream(
        persona=persona if persona is not None else _persona(directory),
        persona_source=persona_source if persona_source is not None else GitPersonaSource(tmp_path),
        resources=resources if resources is not None else FakeResources(),
        backend=backend
        if backend is not None
        else TwoCallBackend(candidate_response=_valid_candidate()),
        runner=runner if runner is not None else RecordingRunner(),
        embedder=embedder if embedder is not None else FakeEmbedder(vectors=[[1.0], [1.0]]),
        state=state if state is not None else FakeState(),
        settings=settings if settings is not None else Settings(drift_mode="scalar"),
        agent_root=tmp_path,
        now=NOW,
        captured_at=CAPTURED_AT,
        auto=auto,
    )


# ── Step 1: write-ordering ───────────────────────────────────────────────


def test_the_write_sequence_matches_bash(tmp_path: Path) -> None:
    """Mutation this catches: swapping any two of the seven steps (e.g.
    writing the memlines marker after the memory append, or uploading the
    snapshot before the personality write) changes this list."""
    directory = _write_account(tmp_path)
    order: list[str] = []
    persona_source = FakePersonaSource(order=order)
    state = FakeState(order=order)
    resources = FakeResources(order=order)
    backend = TwoCallBackend(candidate_response=_valid_candidate(), order=order)

    result = _run(
        tmp_path,
        directory,
        persona_source=persona_source,
        state=state,
        resources=resources,
        backend=backend,
    )

    assert result.accepted is True
    assert order == [
        "diff_narrative",
        "archive_prepend",
        "personality_write",
        "marker_last_dream",
        "marker_memlines",
        "memory_append",
        "snapshot_upload",
    ]


def test_the_memlines_marker_is_written_before_the_memory_append(tmp_path: Path) -> None:
    """The quirk from contract `03` §4: the memlines marker is written
    BEFORE the "personality consolidated" housekeeping line is appended, so
    that line self-counts toward the next round's cooldown-override tally.
    Mutation this catches: computing/recording the memlines count AFTER
    `append_memory` (or re-reading memory.md at that point) would record
    101, not 100."""
    memory_text = "\n".join(f"2026-08-01 | act | thing {i}" for i in range(100)) + "\n"
    directory = _write_account(tmp_path, memory_text=memory_text)
    assert memory_text.count("\n") == 100
    state = FakeState()

    result = _run(tmp_path, directory, state=state)

    assert result.recorded_memlines == 100
    assert state.last_dream_memlines("zenith") == 100


def test_a_mangled_ai_backend_is_pinned_back_and_written(tmp_path: Path) -> None:
    """Spec §12 write path: `AI Backend: Claude` is restored to the live
    file's exact `claude` bytes and the dream is accepted."""
    directory = _write_account(tmp_path)
    mangled = ORIGINAL.replace("- **AI Backend:** claude", "- **AI Backend:** Claude")
    result = _run(
        tmp_path,
        directory,
        backend=TwoCallBackend(candidate_response=mangled),
    )
    assert result.accepted is True
    written = (directory / "personality.md").read_text(encoding="utf-8")
    assert "- **AI Backend:** claude" in written
    assert "- **AI Backend:** Claude" not in written


def test_a_rejected_dream_touches_nothing(tmp_path: Path) -> None:
    """Mutation this catches: calling `persona_source.archive_and_write` (or
    anything else that writes) before checking `verdict.accepted`."""
    directory = _write_account(tmp_path)
    before_personality = (directory / "personality.md").read_text(encoding="utf-8")
    before_memory = (directory / "memory.md").read_text(encoding="utf-8")
    archive_path = directory / "personality.archive.md"
    assert not archive_path.exists()
    resources = FakeResources()

    result = _run(
        tmp_path,
        directory,
        resources=resources,
        backend=TwoCallBackend(candidate_response=_bad_username_candidate()),
    )

    assert result.accepted is False
    assert result.proceeded is True
    assert (directory / "personality.md").read_text(encoding="utf-8") == before_personality
    assert (directory / "memory.md").read_text(encoding="utf-8") == before_memory
    assert not archive_path.exists()
    assert resources.calls == []


# ── Step 2: snapshot failure ─────────────────────────────────────────────


def test_a_snapshot_failure_does_not_roll_back_the_personality_write(tmp_path: Path) -> None:
    directory = _write_account(tmp_path)
    candidate = _valid_candidate()
    resources = FakeResources(snapshot_raises=WriteNotVerifiedError("rejected"))

    result = _run(
        tmp_path,
        directory,
        resources=resources,
        backend=TwoCallBackend(candidate_response=candidate),
    )

    assert result.accepted is True
    assert result.snapshot_ok is False
    assert (directory / "personality.md").read_text(encoding="utf-8") == clean_candidate(candidate)


def test_the_snapshot_failure_reason_comes_from_the_error_not_a_guess(tmp_path: Path) -> None:
    """Preserves a lesson Bash learned the hard way (dream.sh's comment at
    the WARN line, contract `03` §4.9): quote the failure's OWN message,
    never a hardcoded guess like "(server or embedder unreachable)"."""
    directory = _write_account(tmp_path)
    resources = FakeResources(snapshot_raises=WriteNotVerifiedError("no api_key.txt"))

    result = _run(
        tmp_path,
        directory,
        resources=resources,
        backend=TwoCallBackend(candidate_response=_valid_candidate()),
    )

    assert result.accepted is True
    assert "no api_key.txt" in (result.snapshot_reason or "")


def test_snapshot_embed_failure_is_also_a_warn_not_a_rollback(tmp_path: Path) -> None:
    """The OTHER way `snapshot.sh` can fail (contract `03` §5's failure mode
    6-7): the embedder, not the server. `fail_on_call=3` fails the THIRD
    embedder call -- the gate's scalar mode makes exactly two (anchor,
    candidate), so the third is the snapshot's own candidate-text embed."""
    directory = _write_account(tmp_path)
    candidate = _valid_candidate()
    embedder = FakeEmbedder(vectors=[[1.0], [1.0]], fail_on_call=3)

    result = _run(
        tmp_path,
        directory,
        backend=TwoCallBackend(candidate_response=candidate),
        embedder=embedder,
    )

    assert result.accepted is True
    assert result.snapshot_ok is False
    assert result.snapshot_reason is not None
    assert (directory / "personality.md").read_text(encoding="utf-8") == clean_candidate(candidate)


# ── Step 3: snapshot payload shape ───────────────────────────────────────


def test_snapshot_payload_shape() -> None:
    payload = build_snapshot_payload(
        text="x" * 400,
        directory=Path("/agent/agents/zenith"),
        agent_root=Path("/agent"),
        embedding=[0.1] * 1024,
        captured_at=datetime(2026, 8, 17, 12, tzinfo=UTC),
    )
    assert payload["snapshotType"] == "dream"
    assert payload["capturedAt"] == "2026-08-17T12:00:00Z"
    assert payload["archivePath"] == "agents/zenith/personality.md"
    assert len(payload["excerpt"]) == 280
    assert payload["contentHash"] == hashlib.sha256(("x" * 400).encode()).hexdigest()
    assert payload["embedding"] == [0.1] * 1024
    assert "diffNarrative" not in payload
    assert "aspectDrift" not in payload


def test_the_excerpt_counts_characters_not_bytes() -> None:
    """Guards a real historical bug: Bash's first attempt used `head -c
    280`, which split a multibyte CJK character and crashed the downstream
    `jq --arg` under `set -e`. Mutation this catches: slicing `text.encode()`
    to 280 BYTES instead of slicing the string to 280 characters."""
    payload = build_snapshot_payload(
        text="中" * 400,
        directory=Path("/agent/agents/zenith"),
        agent_root=Path("/agent"),
        embedding=[0.1],
        captured_at=datetime(2026, 8, 17, 12, tzinfo=UTC),
    )
    assert len(payload["excerpt"]) == 280
    assert payload["excerpt"] == "中" * 280


def test_excerpt_flattens_newlines_to_spaces() -> None:
    payload = build_snapshot_payload(
        text="line one\nline two",
        directory=Path("/agent/agents/zenith"),
        agent_root=Path("/agent"),
        embedding=[0.1],
        captured_at=datetime(2026, 8, 17, 12, tzinfo=UTC),
    )
    assert payload["excerpt"] == "line one line two"


def test_optional_fields_are_omitted_when_absent() -> None:
    payload = build_snapshot_payload(
        text="hello",
        directory=Path("/agent/agents/zenith"),
        agent_root=Path("/agent"),
        embedding=[0.1],
        captured_at=datetime(2026, 8, 17, 12, tzinfo=UTC),
        narrative="",
        aspect_drift=None,
    )
    assert "diffNarrative" not in payload
    assert "aspectDrift" not in payload


def test_optional_fields_are_included_when_present() -> None:
    payload = build_snapshot_payload(
        text="hello",
        directory=Path("/agent/agents/zenith"),
        agent_root=Path("/agent"),
        embedding=[0.1],
        captured_at=datetime(2026, 8, 17, 12, tzinfo=UTC),
        narrative="一些叙述",
        aspect_drift={"mode": "aspect", "values": 0.9},
    )
    assert payload["diffNarrative"] == "一些叙述"
    assert payload["aspectDrift"] == {"mode": "aspect", "values": 0.9}


# ── Step 4: run_dream composition ────────────────────────────────────────


def test_run_dream_raises_lock_busy_when_the_dream_lock_is_held(tmp_path: Path) -> None:
    directory = _write_account(tmp_path)
    lock = dream_lock_path(tmp_path, "zenith")
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text("1", encoding="utf-8")

    with pytest.raises(LockBusy):
        _run(tmp_path, directory, backend=ExplodingBackend())  # must never be reached

    assert lock.read_text(encoding="utf-8") == "1"


def test_run_dream_releases_the_lock_even_when_a_step_raises(tmp_path: Path) -> None:
    directory = _write_account(tmp_path)

    with pytest.raises(RuntimeError):
        _run(tmp_path, directory, backend=ExplodingBackend())

    assert not dream_lock_path(tmp_path, "zenith").exists()


def test_cooldown_skip_touches_nothing(tmp_path: Path) -> None:
    """Mutation this catches: calling `check_cooldown` but ignoring a
    `proceed=False` result (or calling the backend regardless) -- the
    ExplodingBackend trap makes either an uncaught error."""
    directory = _write_account(tmp_path)
    state = FakeState()
    state.set_last_dream(hours_ago=1, memlines=100, name="zenith")

    result = _run(
        tmp_path,
        directory,
        state=state,
        backend=ExplodingBackend(),
        auto=True,
    )

    assert result.proceeded is False
    assert result.accepted is False
    assert "cooldown" in result.reason


def test_empty_candidate_touches_nothing(tmp_path: Path) -> None:
    directory = _write_account(tmp_path)
    persona_source = FakePersonaSource()
    before = (directory / "personality.md").read_text(encoding="utf-8")

    result = _run(
        tmp_path,
        directory,
        persona_source=persona_source,
        backend=SilentBackend(),
    )

    assert result.proceeded is True
    assert result.accepted is False
    assert result.reason == "LLM returned empty"
    assert persona_source.archived == []
    assert (directory / "personality.md").read_text(encoding="utf-8") == before


def test_cooldown_override_proceeds_and_logs(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """The "accumulated enough new memory, break the cooldown early" path
    (contract `03` §1.3) -- `cooldown.reason` is non-empty AND `proceed` is
    `True`, distinct from both the silent-proceed paths (reason == "") and
    the SKIP path (proceed == False)."""
    memory_text = "\n".join(f"2026-08-01 | act | thing {i}" for i in range(20)) + "\n"
    directory = _write_account(tmp_path, memory_text=memory_text)
    state = FakeState()
    state.set_last_dream(hours_ago=1, memlines=0, name="zenith")

    with caplog.at_level(logging.INFO):
        result = _run(tmp_path, directory, state=state, auto=True)

    assert result.accepted is True
    assert any("cooldown override" in r.message for r in caplog.records)


def test_memory_archive_tail_is_read_when_present(tmp_path: Path) -> None:
    directory = _write_account(tmp_path)
    lines = "\n".join(f"archived line {i}" for i in range(30)) + "\n"
    (directory / "memory.archive.md").write_text(lines, encoding="utf-8")
    backend = TwoCallBackend(candidate_response=_valid_candidate())

    result = _run(tmp_path, directory, backend=backend)

    assert result.accepted is True
    assert "archived line 29" in backend.calls[0].user
    assert "archived line 9" not in backend.calls[0].user  # only the last 20 lines


def test_group_memory_degrades_to_empty_on_api_failure(tmp_path: Path) -> None:
    directory = _write_account(tmp_path)
    resources = FakeResources()
    resources.fail("notifications")

    result = _run(tmp_path, directory, resources=resources)

    assert result.accepted is True


def test_echo_hint_is_consumed_and_forwarded_into_the_prompt(tmp_path: Path) -> None:
    directory = _write_account(tmp_path)
    state_dir = tmp_path / ".agent-state"
    state_dir.mkdir(parents=True)
    flag = state_dir / "echo_flag_zenith"
    flag.write_text("换个话题试试", encoding="utf-8")
    backend = TwoCallBackend(candidate_response=_valid_candidate())

    result = _run(tmp_path, directory, backend=backend)

    assert result.accepted is True
    assert not flag.exists()
    assert "换个话题试试" in backend.calls[0].user


def test_diff_narrative_falls_back_to_empty_string_on_backend_failure(tmp_path: Path) -> None:
    directory = _write_account(tmp_path)
    backend = TwoCallBackend(
        candidate_response=_valid_candidate(),
        narrative_raises=BackendUnavailableError("dead"),
    )

    result = _run(tmp_path, directory, backend=backend)

    assert result.accepted is True
    assert result.narrative == ""


def test_diff_narrative_does_not_abort_a_cursor_dream_on_missing_model(
    tmp_path: Path,
) -> None:
    """Cursor refuses `model=None` (`auto` is not a stable IV). That must
    degrade the narrative, not the already-accepted dream -- 2026-08-23
    three cursor accounts posted then died at rc=75 here."""
    directory = _write_account(tmp_path)
    backend = TwoCallBackend(
        candidate_response=_valid_candidate(),
        narrative_raises=BackendConfigurationError("the cursor backend requires an explicit model"),
    )

    result = _run(tmp_path, directory, backend=backend)

    assert result.accepted is True
    assert result.narrative == ""


def test_diff_narrative_call_passes_no_model_override_even_when_the_persona_has_one(
    tmp_path: Path,
) -> None:
    """dream.sh's own `_diff_narrative` calls `llm_text "$backend" "" "$sys"
    "$usr"` -- a LITERAL empty model argument, NOT `$ai_model` -- verified by
    reading the script directly (dream.sh:105-115), not assumed from the
    contract doc. Mutation this catches: passing `persona.model` into the
    diff-narrative request instead of `None`."""
    directory = _write_account(tmp_path)
    persona = _persona(directory, model="opus")
    backend = TwoCallBackend(candidate_response=_valid_candidate())

    _run(tmp_path, directory, persona=persona, backend=backend)

    assert backend.calls[0].model == "opus"
    assert backend.calls[1].model is None


def test_diff_narrative_on_cursor_uses_the_persona_model(tmp_path: Path) -> None:
    """Cursor has no CLI default. The empty bash model arg meant 'use the
    CLI default'; for cursor that is `auto`, which we refuse, so the
    account's pinned model is the only stable stand-in."""

    class CursorNamedBackend(TwoCallBackend):
        name = "cursor"

    directory = _write_account(tmp_path)
    persona = _persona(directory, model="cursor-grok-4.6-high")
    backend = CursorNamedBackend(candidate_response=_valid_candidate())

    _run(tmp_path, directory, persona=persona, backend=backend)

    assert backend.calls[0].model == "cursor-grok-4.6-high"
    assert backend.calls[1].model == "cursor-grok-4.6-high"


def test_diff_narrative_puts_the_model_on_the_cursor_argv() -> None:
    """The 2026-08-23 raise lived in CursorCLIBackend.complete, not the fake."""
    runner = RecordingRunner("ok")
    backend = CursorCLIBackend(runner)
    _diff_narrative("old", "new", backend, model="cursor-grok-4.6-high")
    argv = runner.calls[0].argv
    assert "--model" in argv
    assert argv[argv.index("--model") + 1] == "cursor-grok-4.6-high"


def test_aspect_drift_is_attached_to_the_snapshot_payload_in_aspect_mode(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    directory = _write_account(tmp_path)
    _write_anchor_cache(
        directory,
        anchor_text=RESOLVED_ANCHOR,
        vectors=AspectVectors(values=[1.0], style=[1.0], topic=[1.0]),
    )
    embedder = FakeEmbedder([[1.0], [1.0], [0.99], [0.99], [0.99]])
    runner = RecordingRunner('{"values":"a","style":"b","topic":"c"}')
    resources = FakeResources()

    with caplog.at_level(logging.WARNING):
        result = _run(
            tmp_path,
            directory,
            resources=resources,
            backend=TwoCallBackend(candidate_response=_valid_candidate()),
            runner=runner,
            embedder=embedder,
            settings=Settings(drift_mode="aspect"),
        )

    assert result.accepted is True
    assert result.verdict is not None
    assert result.verdict.sims == AspectSims(values=0.99, style=0.99, topic=0.99)
    _, payload = resources.snapshots[0]
    assert payload["aspectDrift"] == {
        "mode": "aspect",
        "promptVersion": 2,
        "values": 0.99,
        "style": 0.99,
        "topic": 0.99,
        "breached": [],
    }
    # `== 2` alone would also pass for `"2"` under a loose comparison and,
    # worse, `True == 1` in Python -- so assert the wire TYPE explicitly.
    # `agents.schemas.ts`'s `aspectDriftIngest` declares
    # `promptVersion: z.number().int().nonnegative()` with no `.coerce`, so
    # a JSON string fails validation and the server rejects the whole
    # snapshot ingest: an accepted dream that silently records no snapshot.
    assert type(payload["aspectDrift"]["promptVersion"]) is int
    # ... and it must survive JSON encoding as a number, which is what
    # actually reaches Zod (`jq -n --argjson pv`, dream.sh:769).
    assert '"promptVersion": 2' in json.dumps(payload["aspectDrift"])


def test_the_aspect_cache_key_is_not_affected_by_the_snapshot_prompt_version_type() -> None:
    """`dream/round.py`'s `_ASPECT_PROMPT_VERSION` (an `int`, for the wire)
    and `dream/gate.py`'s (a `str`, for the cache key) are separate
    constants on purpose. This pins the key's bytes against the value a real
    warm cache on disk carries -- `agent/agents/quant/personality.anchor.aspects.json`
    reads `"key": "a72c...085c:v2"` -- so a future "simplification" that
    unified the two constants on the int would be caught here rather than by
    23 accounts silently re-distilling their anchors (~69 `claude` calls).
    """
    assert (
        anchor_cache_key("x", prompt_version=_GATE_PROMPT_VERSION)
        == f"{hashlib.sha256(b'x').hexdigest()}:v2"
    )


# ── Fix round 1, item 1: lab events (dream.sh's `_post_agent_event`) ────────


def test_a_structural_rejection_emits_a_fail_event_with_the_validators_reason(
    tmp_path: Path,
) -> None:
    """The required proof for fix round 1, item 1: a structural rejection
    must be observable through `/lab`, not just through a return value.
    Mutation this catches: `run_dream` returning early on a structural
    reject without ever calling `_emit`."""
    directory = _write_account(tmp_path)
    resources = FakeResources()

    result = _run(
        tmp_path,
        directory,
        resources=resources,
        backend=TwoCallBackend(candidate_response=_bad_username_candidate()),
    )

    assert result.accepted is False
    fail_events = [e for e in resources.lab_events if e.outcome == "fail"]
    assert len(fail_events) == 1
    event = fail_events[0]
    assert event.type == "dream"
    assert event.phase == "dream"
    assert "Follow Topics" in event.summary
    assert event.metrics == {"gateStatus": "struct_reject"}


def test_a_drift_rejection_emits_a_fail_event_with_metrics(tmp_path: Path) -> None:
    directory = _write_account(tmp_path)
    resources = FakeResources()
    # sim = 0.0 * ... well below the 0.82 default threshold.
    embedder = FakeEmbedder(vectors=[[1.0], [0.0]])

    result = _run(
        tmp_path,
        directory,
        resources=resources,
        backend=TwoCallBackend(candidate_response=_valid_candidate()),
        embedder=embedder,
    )

    assert result.accepted is False
    fail_events = [e for e in resources.lab_events if e.outcome == "fail"]
    assert len(fail_events) == 1
    event = fail_events[0]
    assert "drift too large" in event.summary
    assert event.metrics["similarity"] == 0.0
    assert event.metrics["drift"] == 1.0


def test_a_lab_event_outage_does_not_change_the_dream_outcome(tmp_path: Path) -> None:
    """The second required proof for fix round 1, item 1: an events outage
    must never change what `run_dream` returns -- `_emit` swallows whatever
    `resources.lab_event` raises. Mutation this catches: calling
    `resources.lab_event` directly instead of through `_emit`."""
    directory = _write_account(tmp_path)
    resources = FakeResources(lab_event_raises=ApiError(500, "boom", None))

    result = _run(
        tmp_path,
        directory,
        resources=resources,
        backend=TwoCallBackend(candidate_response=_valid_candidate()),
    )

    assert result.accepted is True
    assert result.snapshot_ok is True
    assert resources.lab_events == []  # every attempt raised, so nothing landed


def test_a_lab_event_outage_does_not_change_a_rejection_either(tmp_path: Path) -> None:
    directory = _write_account(tmp_path)
    resources = FakeResources(lab_event_raises=ApiError(500, "boom", None))

    result = _run(
        tmp_path,
        directory,
        resources=resources,
        backend=TwoCallBackend(candidate_response=_bad_username_candidate()),
    )

    assert result.accepted is False
    assert resources.lab_events == []


def test_dream_started_event_fires_once_cooldown_and_lock_pass(tmp_path: Path) -> None:
    directory = _write_account(tmp_path)
    resources = FakeResources()

    result = _run(
        tmp_path,
        directory,
        resources=resources,
        backend=TwoCallBackend(candidate_response=_valid_candidate()),
    )

    assert result.accepted is True
    started = [e for e in resources.lab_events if e.outcome == "started"]
    assert len(started) == 1
    assert started[0].type == "dream"
    assert started[0].summary == "dream started"


def test_cooldown_skip_never_emits_a_started_event(tmp_path: Path) -> None:
    directory = _write_account(tmp_path)
    state = FakeState()
    state.set_last_dream(hours_ago=1, memlines=100, name="zenith")
    resources = FakeResources()

    result = _run(
        tmp_path,
        directory,
        state=state,
        resources=resources,
        backend=ExplodingBackend(),
        auto=True,
    )

    assert result.proceeded is False
    assert resources.lab_events == []


def test_accept_emits_dream_success_and_snapshot_success_events(tmp_path: Path) -> None:
    directory = _write_account(tmp_path)
    resources = FakeResources()

    result = _run(
        tmp_path,
        directory,
        resources=resources,
        backend=TwoCallBackend(candidate_response=_valid_candidate()),
    )

    assert result.accepted is True
    outcomes = [(e.type, e.phase, e.outcome, e.summary) for e in resources.lab_events]
    assert ("dream", "dream", "started", "dream started") in outcomes
    assert ("dream", "dream", "success", "personality updated") in outcomes
    assert ("snapshot", "snapshot", "success", "snapshot uploaded") in outcomes


def test_snapshot_failure_emits_a_warn_event_with_the_real_reason(tmp_path: Path) -> None:
    directory = _write_account(tmp_path)
    resources = FakeResources(snapshot_raises=WriteNotVerifiedError("no api_key.txt"))

    result = _run(
        tmp_path,
        directory,
        resources=resources,
        backend=TwoCallBackend(candidate_response=_valid_candidate()),
    )

    assert result.accepted is True
    warn_events = [e for e in resources.lab_events if e.type == "snapshot" and e.outcome == "warn"]
    assert len(warn_events) == 1
    assert warn_events[0].summary == "snapshot upload failed"
    assert warn_events[0].reason == "no api_key.txt"


def test_llm_empty_output_emits_a_fail_event(tmp_path: Path) -> None:
    directory = _write_account(tmp_path)
    resources = FakeResources()

    result = _run(tmp_path, directory, resources=resources, backend=SilentBackend())

    assert result.accepted is False
    assert result.proceeded is True
    fail_events = [e for e in resources.lab_events if e.outcome == "fail"]
    assert len(fail_events) == 1
    assert fail_events[0].summary == "LLM returned empty"


def test_embedder_unreachable_emits_a_warn_event_but_still_accepts(tmp_path: Path) -> None:
    """Contract `03` §4's fail-open path: the drift check could not run at
    all, so the dream is accepted anyway, but the gap is logged as a WARN
    lab event, not silently absorbed into the eventual success event."""
    directory = _write_account(tmp_path)
    resources = FakeResources()
    embedder = FakeEmbedder(fail_always=True)

    result = _run(
        tmp_path,
        directory,
        resources=resources,
        backend=TwoCallBackend(candidate_response=_valid_candidate()),
        embedder=embedder,
    )

    assert result.accepted is True
    warn_events = [e for e in resources.lab_events if e.outcome == "warn" and e.type == "dream"]
    assert len(warn_events) == 1
    assert warn_events[0].summary == "embedder unreachable, skipped drift check"


def test_embedder_unreachable_still_warns_in_the_deployed_aspect_mode(tmp_path: Path) -> None:
    """The same fail-open WARN as the test above, but in the mode that is
    actually deployed (`DRIFT_MODE=aspect`, `agent/.env`) and with the
    aspect pipeline degraded too -- so `dream/gate.py` prefixes an
    `aspect_note` onto the reason and the composed string is
    `"aspect distill/embed failed, falling back to scalar drift; embedder
    unreachable, skipping drift check"`.

    This is the case an equality test against the bare note text missed.
    The mutation it catches: `if verdict.accepted and verdict.reason ==
    _EMBEDDER_UNREACHABLE_REASON` -- under which the assertion below drops
    from 1 warn event to 0. Losing it is worse than the outage it reports:
    it is the ONLY signal that the constitution layer fail-opened and the
    dream landed ungated, and its absence is indistinguishable from a
    healthy round.

    The test above deliberately stays on `drift_mode="scalar"` (`_run`'s own
    default): the two together pin that BOTH gate branches emit the event,
    which is what `dream.sh:797-807` does -- its `else` covers scalar mode,
    shadow mode, and aspect-mode fallback alike.
    """
    directory = _write_account(tmp_path)
    resources = FakeResources()

    result = _run(
        tmp_path,
        directory,
        resources=resources,
        backend=TwoCallBackend(candidate_response=_valid_candidate()),
        # Distiller is healthy; every EMBED fails -- so the aspect pipeline
        # degrades (non-empty aspect_note) AND the scalar pair is unmeasured.
        runner=RecordingRunner('{"values":"a","style":"b","topic":"c"}'),
        embedder=FakeEmbedder(fail_always=True),
        settings=Settings(drift_mode="aspect"),
    )

    assert result.accepted is True
    assert result.verdict is not None
    assert result.verdict.embedder_unreachable is True
    # The composed reason is preserved verbatim -- operators read it and the
    # drift docs quote its format; only the SIGNAL moved to a typed field.
    assert result.verdict.reason == (
        "aspect distill/embed failed, falling back to scalar drift; "
        "embedder unreachable, skipping drift check"
    )
    warn_events = [e for e in resources.lab_events if e.outcome == "warn" and e.type == "dream"]
    assert len(warn_events) == 1
    assert warn_events[0].summary == "embedder unreachable, skipped drift check"


def test_an_aspect_gated_dream_is_not_flagged_embedder_unreachable(tmp_path: Path) -> None:
    """The other side of the flag: `scalar_sim is None` alone must NOT mean
    "fail-opened". Here the aspect gate has usable sims and decides the
    verdict, so a missing scalar similarity gated nothing and no WARN is
    owed. Mutation this catches: setting `embedder_unreachable = scalar_sim
    is None` unconditionally in `evaluate_candidate` instead of only on the
    scalar branch."""
    directory = _write_account(tmp_path)
    _write_anchor_cache(
        directory,
        anchor_text=RESOLVED_ANCHOR,
        vectors=AspectVectors(values=[1.0], style=[1.0], topic=[1.0]),
    )
    resources = FakeResources()
    embedder = FakeEmbedder(
        # calls: 1 scalar anchor (RAISES -> scalar_sim is None), 2 scalar
        # candidate, then 3-5 the candidate's three aspect cards (the anchor
        # side is served from the seeded cache, so it costs no embed).
        [[1.0], [1.0], [1.0], [1.0], [1.0]],
        fail_on_call=1,
    )

    result = _run(
        tmp_path,
        directory,
        resources=resources,
        backend=TwoCallBackend(candidate_response=_valid_candidate()),
        runner=RecordingRunner('{"values":"a","style":"b","topic":"c"}'),
        embedder=embedder,
        settings=Settings(drift_mode="aspect"),
    )

    assert result.accepted is True
    assert result.verdict is not None
    # The precondition the test needs to be non-vacuous: the SCALAR pair
    # really did fail to compute, and only the aspect gate had anything to
    # go on.
    assert result.verdict.scalar_sim is None
    assert result.verdict.sims is not None
    assert result.verdict.embedder_unreachable is False
    warn_events = [e for e in resources.lab_events if e.outcome == "warn" and e.type == "dream"]
    assert warn_events == []


def test_an_aspect_mode_drift_rejection_emits_aspect_shaped_metrics(tmp_path: Path) -> None:
    """Task 1b (Phase B): `_drift_fail_metrics` used to nest the aspect
    similarities under an `aspects` object and send `breached` as an array
    -- `agentEventIngest.metrics` is `z.record(z.union([z.string(),
    z.number(), z.boolean(), z.null()]))` (`agents.schemas.ts:59`), which
    rejects both shapes, so zod 400'd the WHOLE event and every aspect-mode
    rejection since 2026-07-03 (`DRIFT_MODE=aspect`'s go-live) was silently
    discarded. This pins the FLAT replacement, spelled to match task 1's
    `_drift_metrics` (`aspectValues`/`aspectStyle`/`aspectTopic`/
    `driftMode`) rather than inventing a second convention for the same
    quantities. `breached` has no task-1 counterpart, so it keeps its own
    name; the list is comma-joined into one scalar (aspect names can never
    contain a comma, so this is lossless) -- see
    `test_an_empty_breached_list_and_a_one_element_one_are_distinguishable`
    for why comma-joining still tells "nothing breached" apart from "one
    aspect breached".
    """
    directory = _write_account(tmp_path)
    _write_anchor_cache(
        directory,
        anchor_text=RESOLVED_ANCHOR,
        vectors=AspectVectors(values=[1.0], style=[1.0], topic=[1.0]),
    )
    resources = FakeResources()
    embedder = FakeEmbedder(
        [
            [1.0],  # scalar: anchor (unused -- aspect mode decides)
            [1.0],  # scalar: candidate
            [0.99],  # candidate "values" card -> fine
            [0.10],  # candidate "style" card -> breaches
            [0.99],  # candidate "topic" card -> fine
        ]
    )
    runner = RecordingRunner('{"values":"a","style":"b","topic":"c"}')

    result = _run(
        tmp_path,
        directory,
        resources=resources,
        backend=TwoCallBackend(candidate_response=_valid_candidate()),
        runner=runner,
        embedder=embedder,
        settings=Settings(drift_mode="aspect"),
    )

    assert result.accepted is False
    fail_events = [e for e in resources.lab_events if e.outcome == "fail"]
    assert len(fail_events) == 1
    assert fail_events[0].metrics == {
        "aspectValues": 0.99,
        "aspectStyle": 0.10,
        "aspectTopic": 0.99,
        "breached": "style",
        "driftMode": "aspect",
        "gateStatus": "drift_reject",
    }


def test_an_aspect_mode_drift_rejections_metrics_are_flat_and_wire_legal(
    tmp_path: Path,
) -> None:
    """The TYPE rule `agentEventIngest.metrics` actually enforces, stated as
    a type rule rather than as a list of expected keys -- a key-list test
    (like the one above) passes a payload that keeps a nested value under a
    renamed key, e.g. `{"aspectValues": {"raw": 0.99}}`.

    Two aspects breach here (not one), so `breached` is exercised as a
    multi-element join, not just the single-element case pinned above.

    Mutation this kills, verified by running each separately: putting the
    nested `{"aspects": {...}}` object back into the payload is caught by
    the `isinstance` loop below (a `dict` fails `isinstance(value, str |
    float | int | bool | type(None))`) -- the `==` check on `breached` two
    lines above it still passes, since that mutation leaves `breached`
    untouched. A bare `list[str]` for `breached` is caught earlier, and by
    a DIFFERENT assertion: `assert metrics["breached"] == "values,style"`
    fails directly on the list, and pytest halts there -- the `isinstance`
    loop never runs for that mutation. Both are genuine catches, just not
    the same one: the loop exists for what the exact-match assertion would
    not have caught on its own, which is a key-list test (like the one
    above) passing a payload that keeps a nested value under a renamed key.
    """
    directory = _write_account(tmp_path)
    _write_anchor_cache(
        directory,
        anchor_text=RESOLVED_ANCHOR,
        vectors=AspectVectors(values=[1.0], style=[1.0], topic=[1.0]),
    )
    resources = FakeResources()
    embedder = FakeEmbedder(
        [
            [1.0],  # scalar: anchor (unused -- aspect mode decides)
            [1.0],  # scalar: candidate
            [0.10],  # candidate "values" card -> breaches
            [0.10],  # candidate "style" card -> breaches
            [0.99],  # candidate "topic" card -> fine
        ]
    )
    runner = RecordingRunner('{"values":"a","style":"b","topic":"c"}')

    result = _run(
        tmp_path,
        directory,
        resources=resources,
        backend=TwoCallBackend(candidate_response=_valid_candidate()),
        runner=runner,
        embedder=embedder,
        settings=Settings(drift_mode="aspect"),
    )

    assert result.accepted is False
    fail_events = [e for e in resources.lab_events if e.outcome == "fail"]
    metrics = fail_events[0].metrics
    assert metrics["breached"] == "values,style"
    for key, value in metrics.items():
        assert isinstance(value, str | float | int | bool | type(None)), (
            f"metrics[{key!r}] is {type(value).__name__}, which agentEventIngest rejects"
        )


def test_an_empty_breached_list_and_a_one_element_one_are_distinguishable(
    tmp_path: Path,
) -> None:
    """Brief step 1's second required test: a flattened empty list must not
    collide with a flattened one-element list.

    `shadow` mode is the vehicle: it computes per-aspect sims (so
    `verdict.sims is not None` and this rejection still takes the aspect
    branch of `_drift_fail_metrics`) but DECIDES on the scalar gate alone
    (`dream/gate.py`: `if settings.drift_mode == "aspect" and sims is not
    None: ...  else: accepted, base_reason = _scalar_decision(...)`) -- so a
    rejection with every aspect comfortably inside its own threshold, and
    therefore an EMPTY `breached`, is reachable and realistic, not a
    contrived empty list.

    Mutation this kills: rendering `breached` so `",".join([])` and
    `",".join(["style"])` are not both reachable and distinct -- e.g. a
    sentinel like `"none"` that could also be a real (if odd) aspect label,
    or joining with a separator that silently drops single elements.
    """
    directory = _write_account(tmp_path)
    _write_anchor_cache(
        directory,
        anchor_text=RESOLVED_ANCHOR,
        vectors=AspectVectors(values=[1.0], style=[1.0], topic=[1.0]),
    )
    resources = FakeResources()
    embedder = FakeEmbedder(
        [
            [1.0],  # scalar: anchor
            [0.0],  # scalar: candidate -- sim=0.0, well below the 0.82 default
            [0.99],  # candidate "values" card -> fine
            [0.99],  # candidate "style" card -> fine
            [0.99],  # candidate "topic" card -> fine
        ]
    )
    runner = RecordingRunner('{"values":"a","style":"b","topic":"c"}')

    result = _run(
        tmp_path,
        directory,
        resources=resources,
        backend=TwoCallBackend(candidate_response=_valid_candidate()),
        runner=runner,
        embedder=embedder,
        settings=Settings(drift_mode="shadow"),
    )

    assert result.accepted is False
    fail_events = [e for e in resources.lab_events if e.outcome == "fail"]
    empty_breached = fail_events[0].metrics["breached"]
    assert empty_breached == ""
    assert empty_breached != "style"

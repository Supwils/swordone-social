"""Every ingest body the agent sends, validated against the server's contract.

The JSON Schemas in `tests/contract/*.schema.json` are GENERATED from
`server/src/contract/ingest.ts` (`npm --prefix server run contract:sync`) and
never edited here. This module is the agent's half of that contract (S4 spec
§3.4, §7.16-§7.17):

  (a) the pure builders' output -- `LabEvent.to_wire`, `build_snapshot_payload`
      (including register's `anchor` override), `build_behavior_payload`;
  (b) the `json=` body a real `Resources` sends, captured off an
      `httpx.MockTransport` -- post vectors (round and backfill), bench runs,
      interventions, every lab event;
  (c) every real lab-event emitter, driven through the existing fakes with
      the LAB writes routed through a real `Resources` -- the executor, the
      memory line, the similarity guard, the dream and snapshot steps, the
      behavior sampler's missing-sampler row, the cycle_run card and the
      intervention.

JSON Schema is stricter than the server on purpose (unknown keys, real JSON
types, RFC 3339 with an offset). Where it is LOOSER -- what each generated
`description` lists -- `contract_violations` asserts directly: trimmed
blank strings, non-finite numbers, `pattern` under Python's `re.search`
(trailing newline, non-ASCII digits), and string lengths in UTF-16 code
units, which is what zod's `.max()` counts and `maxLength` here does not.
"""

from __future__ import annotations

import hashlib
import json
import math
import random
import re
import shutil
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Final

import httpx
import pytest
from jsonschema import Draft7Validator
from pydantic import ValidationError

from swil_agent.act.round import execute_step
from swil_agent.analysis.backfill_post_vectors import run_backfill_post_vectors
from swil_agent.analysis.behavior_snapshot import build_behavior_payload
from swil_agent.analysis.cycle_run import build_cycle_run_event, build_missing_sampler_event
from swil_agent.analysis.intervention import (
    DatingBasis,
    InterventionKind,
    build_intervention_event,
    run_intervention,
)
from swil_agent.api.auth import ApiKeyAuth
from swil_agent.api.client import ApiClient, ApiError
from swil_agent.api.dto import (
    EXCERPT_MAX_UNITS,
    REASON_MAX_UNITS,
    SUMMARY_MAX_UNITS,
    TARGET_ID_MAX_UNITS,
    LabEvent,
    cap_utf16,
)
from swil_agent.api.resources import Resources, VectorFiling
from swil_agent.bench.judge import Judge
from swil_agent.bench.models import ModelUnderTest
from swil_agent.bench.persona import BenchPersona
from swil_agent.bench.runner import BenchDeps, load_battery, run_batch_id, run_pair
from swil_agent.config import Settings
from swil_agent.dream.round import (
    build_snapshot_payload,
    dream_step,
    snapshot_content,
    snapshot_step,
    write_step,
)
from swil_agent.embedder.client import EmbedderUnavailable
from swil_agent.graph.deps import CycleDeps
from swil_agent.graph.nodes_tail import make_behavior_snapshot_node, make_logout_node
from swil_agent.models import Action, ActOutcome, Persona
from swil_agent.persona.format import PersonaFormatError
from swil_agent.persona.source import GitPersonaSource
from swil_agent.register import register_account
from swil_agent.round_id import ROUND_ID_RE

from ._runners import (
    FakeEmbedder,
    FakePersonaSource,
    FakeResources,
    FakeState,
    RecordingRunner,
    SilentBackend,
    StubBackend,
    make_persona,
)
from .test_register import PERSONALITY as REGISTER_PERSONALITY
from .test_register import FakeServer as RegisterServer

CONTRACT_DIR: Final = Path(__file__).parents[1] / "contract"
AGENT_ROOT: Final = Path(__file__).resolve().parents[2]
BATTERY: Final = AGENT_ROOT / "bench" / "battery" / "tasks.json"
GENERATED_MARK: Final = "GENERATED from server/src/contract by contract:sync — do not edit."

BODY_NAMES: Final = (
    "agentEventIngest",
    "behaviorSnapshotIngest",
    "benchmarkRunIngest",
    "postVectorIngest",
    "snapshotIngest",
)

# Fields the server `.trim()`s before checking their length bounds. Pinned
# against each schema's generated `description` below, so a field the server
# starts trimming cannot be missed here silently.
TRIMMED: Final[dict[str, frozenset[str]]] = {
    "agentEventIngest": frozenset({"summary", "reason", "targetId"}),
    "benchmarkRunIngest": frozenset({"batchId", "model", "taskId", "taskKind"}),
}

# The ingest route each body is POSTed to (path after `/api/v1`).
_ROUTES: Final = (
    (re.compile(r"/agents/benchmark/runs"), "benchmarkRunIngest"),
    (re.compile(r"/agents/[A-Za-z0-9_]+/events"), "agentEventIngest"),
    (re.compile(r"/agents/[A-Za-z0-9_]+/post-vectors"), "postVectorIngest"),
    (re.compile(r"/agents/[A-Za-z0-9_]+/snapshots"), "snapshotIngest"),
    (re.compile(r"/agents/[A-Za-z0-9_]+/behavior-snapshots"), "behaviorSnapshotIngest"),
)

# What JS `String.prototype.trim` removes (ECMA-262 WhiteSpace + LineTerminator).
# Not `str.strip()`: Python also strips U+001C-U+001F and U+0085, and keeps U+FEFF.
_JS_SPACE: Final = "".join(
    chr(code)
    for code in (
        *(0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680),
        *range(0x2000, 0x200B),
        *(0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF),
    )
)

NOW: Final = datetime(2026, 10, 14, 9, 30, 0, tzinfo=UTC)
SWEEP_ROUND: Final = "20261014T093000Z-r"
POST_ID: Final = "0123456789abcdef01234567"
OTHER_POST: Final = "abcdefabcdefabcdefabcdef"


# ── schemas and the checks JSON Schema cannot make ─────────────────────────


def _load(name: str) -> dict[str, Any]:
    raw: dict[str, Any] = json.loads((CONTRACT_DIR / f"{name}.schema.json").read_text("utf-8"))
    return raw


SCHEMAS: Final = {name: _load(name) for name in BODY_NAMES}
VALIDATORS: Final = {
    name: Draft7Validator(schema, format_checker=Draft7Validator.FORMAT_CHECKER)
    for name, schema in SCHEMAS.items()
}


def _body_schema(name: str) -> dict[str, Any]:
    definition: dict[str, Any] = SCHEMAS[name]["definitions"][name]
    return definition


def _js_trim(text: str) -> str:
    return text.strip(_JS_SPACE)


def _utf16_len(text: str) -> int:
    """`String.prototype.length`, which is what zod's `.min()`/`.max()` count.
    `maxLength` in Python counts code points, so an astral character (an
    emoji) is one here and two on the server."""
    return len(text.encode("utf-16-le")) // 2


def _branch_fits(schema: dict[str, Any], value: Any) -> bool:
    kind = schema.get("type")
    if kind == "null":
        return value is None
    if kind == "string":
        return isinstance(value, str)
    if kind in ("number", "integer"):
        return isinstance(value, int | float) and not isinstance(value, bool)
    return True


def _fullmatch_pattern(pattern: str) -> re.Pattern[str]:
    """ECMA-262 `^...$` as Python must apply it: whole string, ASCII `\\d`."""
    assert pattern.startswith("^") and pattern.endswith("$"), pattern
    return re.compile(pattern[1:-1], re.ASCII)


def _walk(
    schema: dict[str, Any], value: Any, path: str, trimmed: frozenset[str], out: list[str]
) -> None:
    if "anyOf" in schema:
        for branch in schema["anyOf"]:
            if _branch_fits(branch, value):
                _walk(branch, value, path, trimmed, out)
        return
    if isinstance(value, str) and schema.get("type") == "string":
        text = _js_trim(value) if path in trimmed else value
        units = _utf16_len(text)
        if path in trimmed and units < schema.get("minLength", 0):
            out.append(f"{path}: {value!r} is shorter than {schema['minLength']} after trim")
        if "maxLength" in schema and units > schema["maxLength"]:
            out.append(f"{path}: {units} UTF-16 units > maxLength {schema['maxLength']}")
        if "pattern" in schema and not _fullmatch_pattern(schema["pattern"]).fullmatch(value):
            out.append(f"{path}: {value!r} does not fullmatch {schema['pattern']} (ASCII)")
        if schema.get("format") == "date-time":
            try:
                parsed = datetime.fromisoformat(value)
            except ValueError:
                out.append(f"{path}: {value!r} is not an ISO date-time")
            else:
                if parsed.tzinfo is None:
                    out.append(f"{path}: {value!r} is naive (no offset)")
    elif isinstance(value, dict):
        properties: dict[str, Any] = schema.get("properties", {})
        extra = schema.get("additionalProperties")
        for key, item in value.items():
            sub = properties.get(key, extra if isinstance(extra, dict) else None)
            if sub is not None:
                _walk(sub, item, f"{path}.{key}" if path else key, trimmed, out)
    elif isinstance(value, list) and isinstance(schema.get("items"), dict):
        for index, item in enumerate(value):
            _walk(schema["items"], item, f"{path}[{index}]", trimmed, out)


def _non_finite(value: Any, path: str, out: list[str]) -> None:
    if isinstance(value, float) and not math.isfinite(value):
        out.append(f"{path or '<root>'}: {value!r} is not finite")
    elif isinstance(value, dict):
        for key, item in value.items():
            _non_finite(item, f"{path}.{key}" if path else key, out)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _non_finite(item, f"{path}[{index}]", out)


def contract_violations(name: str, body: Any) -> list[str]:
    """Everything the server would refuse in `body`, and everything the
    schema rejects on purpose. Empty means the body honours the contract."""
    out = [
        f"{'/'.join(str(p) for p in error.absolute_path) or '<root>'}: {error.message}"
        for error in VALIDATORS[name].iter_errors(body)
    ]
    _non_finite(body, "", out)
    _walk(_body_schema(name), body, "", TRIMMED.get(name, frozenset()), out)
    if name == "agentEventIngest" and isinstance(body, dict):
        # Not in `agentEventIngest` (metrics are free-form scalars), but the
        # arms report joins cycle_run cards and similarity rows on it.
        metrics = body.get("metrics")
        round_id = metrics.get("roundId") if isinstance(metrics, dict) else None
        if isinstance(round_id, str) and not ROUND_ID_RE.fullmatch(round_id):
            out.append(f"metrics.roundId: {round_id!r} is not a round id")
    return out


def assert_honours(name: str, body: Any) -> None:
    problems = contract_violations(name, body)
    assert not problems, f"{name} body breaks the contract: {problems}\nbody: {body!r}"


# ── the capturing transport ─────────────────────────────────────────────────


@dataclass(frozen=True)
class Sent:
    method: str
    path: str
    body: Any

    @property
    def ingest(self) -> str | None:
        if self.method != "POST":
            return None
        for route, name in _ROUTES:
            if route.fullmatch(self.path):
                return name
        return None


class Wire:
    """An `httpx.MockTransport` handler that records every request body and
    answers each ingest route the way the server does on success. `fail`
    maps a body name to the response that route answers instead; `posts` is
    what `GET /users/:u/posts` lists."""

    def __init__(self) -> None:
        self.sent: list[Sent] = []
        self.fail: dict[str, httpx.Response] = {}
        self.posts: list[dict[str, Any]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/api/v1")
        body = json.loads(request.content) if request.content else None
        sent = Sent(request.method, path, body)
        self.sent.append(sent)
        n = len(self.sent)
        name = sent.ingest
        if name in self.fail:
            return self.fail[name]
        if name == "agentEventIngest":
            return httpx.Response(201, json={"data": {"event": {"id": f"evt-{n}"}}})
        if name == "snapshotIngest":
            data = {"id": f"snap-{n}", "driftFromAnchor": 0.1, "driftFromPrev": 0.0}
            return httpx.Response(201, json={"data": data})
        if name == "behaviorSnapshotIngest":
            return httpx.Response(201, json={"data": {"id": f"beh-{n}", "fidelity": 0.8}})
        if name is not None:  # post vectors, bench runs
            return httpx.Response(201, json={"data": {"id": f"{n:016x}"}})
        if request.method == "GET" and re.fullmatch(r"/users/[A-Za-z0-9_]+/posts", path):
            return httpx.Response(200, json={"data": {"items": self.posts, "nextCursor": None}})
        return httpx.Response(404, json={"error": {"code": "NOT_FOUND", "message": path}})

    def resources(self) -> Resources:
        client = ApiClient("http://127.0.0.1:9", ApiKeyAuth("k"), httpx.MockTransport(self))
        return Resources(client)

    def bodies(self, name: str) -> list[Any]:
        return [sent.body for sent in self.sent if sent.ingest == name]

    def events(self) -> list[dict[str, Any]]:
        return list(self.bodies("agentEventIngest"))

    def assert_all_honour(self) -> list[Sent]:
        """Every ingest body sent so far honours its schema. Returns them."""
        ingests = [sent for sent in self.sent if sent.ingest is not None]
        for sent in ingests:
            assert sent.ingest is not None
            assert_honours(sent.ingest, sent.body)
        return ingests


class WiredResources(FakeResources):
    """`FakeResources` for the social surface and the reads, a REAL
    `Resources` for every lab write -- so an emitter's body reaches the wire
    exactly as production serialises it, and is recorded by both."""

    def __init__(self, wire: Wire, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.real = wire.resources()

    def lab_event(self, username: str, event: LabEvent) -> None:
        super().lab_event(username, event)
        self.real.lab_event(username, event)

    def record_intervention(self, username: str, event: LabEvent) -> str:
        self.interventions.append((username, event))
        return self.real.record_intervention(username, event)

    def post_vector(self, username: str, **kwargs: Any) -> bool:
        self.post_vectors.append((username, kwargs))
        return self.real.post_vector(username, **kwargs)

    def file_post_vector(self, username: str, **kwargs: Any) -> VectorFiling:
        self.post_vectors.append((username, kwargs))
        return self.real.file_post_vector(username, **kwargs)

    def create_snapshot(self, username: str, payload: dict[str, Any]) -> str:
        self.snapshots.append((username, payload))
        return self.real.create_snapshot(username, payload)

    def create_behavior_snapshot(
        self, username: str, payload: dict[str, Any]
    ) -> tuple[str, float | None]:
        self.behavior_snapshots.append((username, payload))
        return self.real.create_behavior_snapshot(username, payload)


class UnitEmbedder:
    """bge-m3-shaped: one 1024-dim unit vector per text, the same vector for
    the same text, so a repeated post scores a cosine of ~1.0."""

    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail

    def embed(self, texts: list[str]) -> list[list[float]]:
        if self.fail:
            raise EmbedderUnavailable("embed failed: connection refused")
        return [unit_vector(text) for text in texts]


def unit_vector(text: str, dim: int = 1024) -> list[float]:
    rng = random.Random(hashlib.sha256(text.encode()).digest())
    raw = [rng.gauss(0.0, 1.0) for _ in range(dim)]
    norm = math.sqrt(sum(x * x for x in raw))
    return [x / norm for x in raw]


@pytest.fixture
def wire() -> Wire:
    return Wire()


def _persona_dir(tmp_path: Path, name: str = "zenith") -> Path:
    directory = tmp_path / "agents" / name
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "memory.md").write_text("2026-10-13 | like | postId=x\n", encoding="utf-8")
    (directory / "api_key.txt").write_text("k\n", encoding="utf-8")
    return directory


def _persona(tmp_path: Path, **overrides: Any) -> Persona:
    fields: dict[str, Any] = {
        "username": "zenith",
        "directory": _persona_dir(tmp_path),
        "card": "# 天顶\n\n一个写天文的账号，说话很短。",
    }
    fields.update(overrides)
    return make_persona(**fields)


def _real_roster() -> list[Path]:
    directories = sorted(p.parent for p in (AGENT_ROOT / "agents").glob("*/personality.md"))
    assert len(directories) >= 20, "the Era 3 roster is expected to have 20 accounts"
    return directories


# ── 0. the schemas themselves ───────────────────────────────────────────────


def test_every_generated_schema_is_covered_here_and_well_formed() -> None:
    on_disk = sorted(p.name.removesuffix(".schema.json") for p in CONTRACT_DIR.glob("*.json"))
    assert on_disk == sorted(BODY_NAMES), "a new ingest body needs a test in this module"
    for name, schema in SCHEMAS.items():
        Draft7Validator.check_schema(schema)
        assert schema["$comment"] == GENERATED_MARK
        assert schema["$ref"] == f"#/definitions/{name}"
        assert _body_schema(name)["additionalProperties"] is False


def test_the_date_time_format_is_really_checked() -> None:
    """Without `rfc3339-validator` installed, `format: date-time` is silently
    a no-op and every naive-datetime test below would pass vacuously."""
    checker = Draft7Validator.FORMAT_CHECKER
    assert "date-time" in checker.checkers
    assert not checker.conforms("2026-10-14T09:30:00", "date-time")
    assert checker.conforms("2026-10-14T09:30:00Z", "date-time")


def test_the_trimmed_and_pattern_fields_here_are_the_ones_the_schemas_name() -> None:
    for name in BODY_NAMES:
        description = SCHEMAS[name]["description"]
        match = re.search(r"the server trims (.+?) before checking", description)
        named = frozenset(match.group(1).split(", ")) if match else frozenset()
        assert named == TRIMMED.get(name, frozenset()), name
    vector = _body_schema("postVectorIngest")["properties"]["roundId"]["anyOf"][0]
    assert vector["pattern"] == ROUND_ID_RE.pattern
    assert ROUND_ID_RE.flags & re.ASCII


# ── (a) pure builders ───────────────────────────────────────────────────────


def test_lab_event_to_wire_minimal_and_full() -> None:
    minimal = LabEvent(type="cycle", phase="act", outcome="started", summary="cycle started")
    assert_honours("agentEventIngest", minimal.to_wire())
    full = LabEvent(
        type="cycle",
        phase="act",
        outcome="success",
        summary="评论了一条",
        action="comment",
        reason="because",
        target_id=POST_ID,
        occurred_at=datetime(2026, 10, 1, 8, 0, tzinfo=timezone(timedelta(hours=8))),
        metrics={"a": 1, "b": 0.5, "c": "x", "d": True, "e": None},
    )
    wire_body = full.to_wire()
    assert wire_body["occurredAt"] == "2026-10-01T08:00:00+08:00"
    assert_honours("agentEventIngest", wire_body)
    placeholder = LabEvent(type="cycle", phase="act", outcome="skip", summary="s", action="-")
    assert "action" not in placeholder.to_wire()
    assert_honours("agentEventIngest", placeholder.to_wire())


@pytest.mark.parametrize("directory", _real_roster(), ids=lambda p: p.name)
def test_build_snapshot_payload_for_every_real_persona(directory: Path) -> None:
    """Every Era 3 card, with a full 最近 of five 60-character items: the
    excerpt and archive path stay inside the server's bounds."""
    persona = GitPersonaSource(AGENT_ROOT).load(directory.name)
    recent = [f"{i}" + "最" * 59 for i in range(5)]
    text = snapshot_content(persona, recent)
    payload = build_snapshot_payload(
        text=text,
        directory=persona.directory,
        agent_root=AGENT_ROOT,
        embedding=unit_vector(text),
        captured_at=NOW,
    )
    assert payload["snapshotType"] == "dream"
    assert_honours("snapshotIngest", payload)


def test_register_sends_an_anchor_snapshot_that_honours_the_contract(tmp_path: Path) -> None:
    directory = tmp_path / "agents" / "xiaoman"
    directory.mkdir(parents=True)
    (directory / "personality.md").write_text(REGISTER_PERSONALITY, encoding="utf-8")
    server = RegisterServer()
    settings = Settings(agent_root=tmp_path, swil_url="http://127.0.0.1:9", swil_pass="pw")  # type: ignore[call-arg]
    result = register_account(
        settings,
        GitPersonaSource(tmp_path),
        "xiaoman",
        http=httpx.MockTransport(server),
        embedder=FakeEmbedder(vectors=[unit_vector("anchor")]),
    )
    assert result.anchor_posted
    bodies = [body for _, path, body, _ in server.calls if path == "/agents/xiaoman/snapshots"]
    assert len(bodies) == 1
    assert bodies[0]["snapshotType"] == "anchor"
    assert_honours("snapshotIngest", bodies[0])


def test_build_behavior_payload_honours_the_contract() -> None:
    text = "\n---\n".join(["今天看到木星了。", "一条带 emoji 的帖子 🌌", "第三条"])
    payload = build_behavior_payload(
        text=text, post_count=3, embedding=unit_vector(text), captured_at=NOW
    )
    assert_honours("behaviorSnapshotIngest", payload)


# ── (b) bodies captured off the transport ───────────────────────────────────


@pytest.mark.parametrize(
    ("round_id", "card_sim", "max_sim"),
    [(SWEEP_ROUND, 0.61, 0.43), ("20261014T093000Z-m", -0.2, None), (None, None, None)],
)
def test_post_vector_body(
    wire: Wire, round_id: str | None, card_sim: float | None, max_sim: float | None
) -> None:
    filed = wire.resources().post_vector(
        "zenith",
        post_id=POST_ID,
        round_id=round_id,
        embedding=unit_vector("p"),
        card_sim=card_sim,
        max_sim=max_sim,
    )
    assert filed
    [body] = wire.bodies("postVectorIngest")
    assert body["roundId"] == round_id  # sent as null, never omitted
    assert_honours("postVectorIngest", body)


def test_backfill_post_vectors_bodies(wire: Wire) -> None:
    wire.posts = [
        {"id": f"{n:024x}", "text": f"第 {n} 条", "createdAt": "2026-10-15T08:00:00.000Z"}
        for n in range(1, 4)
    ]
    result = run_backfill_post_vectors(
        wire.resources(),
        username="zenith",
        card="一个写天文的账号。",
        embedder=UnitEmbedder(),
        era_start=datetime(2026, 10, 14, tzinfo=UTC),
        clock=lambda: 0.0,
        sleep=lambda _s: None,
    )
    assert result.filed == 3
    bodies = wire.bodies("postVectorIngest")
    assert [b["roundId"] for b in bodies] == [None, None, None]
    for body in bodies:
        assert_honours("postVectorIngest", body)


@dataclass
class _Ticker:
    now: float = 100.0

    def __call__(self) -> float:
        self.now += 1.25
        return self.now


def _bench_root(tmp_path: Path) -> list[str]:
    """Copies of every real persona file the bench can replay (Era 3 and the
    sealed Era 2 roster) with a dummy key -- the real keys are never read."""
    names: list[str] = []
    for base in ("agents", "archive/era-2/agents", "archive/era-2/humans"):
        for source in sorted((AGENT_ROOT / base).glob("*/personality.md")):
            name = source.parent.name
            if name in names:
                continue
            target = tmp_path / base / name
            target.mkdir(parents=True)
            shutil.copyfile(source, target / "personality.md")
            (target / "api_key.txt").write_text("k\n", encoding="utf-8")
            names.append(name)
    assert len(names) >= 50
    return names


def test_bench_run_bodies_for_every_persona_and_every_battery_task(
    wire: Wire, tmp_path: Path
) -> None:
    names = _bench_root(tmp_path)
    tasks = load_battery(BATTERY)
    sink = wire.resources()

    def resolve(spec: str) -> ModelUnderTest:
        return ModelUnderTest(spec, StubBackend(" 一句平静的话 #日常\n"), spec)

    def sink_for(_persona: BenchPersona) -> Resources:
        return sink

    deps = BenchDeps(
        agent_root=tmp_path,
        resolve=resolve,
        embedder=UnitEmbedder(),
        sink_for=sink_for,
        judge=Judge(RecordingRunner("73")),
        now=lambda: NOW,
        emit=lambda _line: None,
        emit_err=lambda _line: None,
        clock=_Ticker(),
        sleep=lambda _s: None,
    )
    batch = run_batch_id(NOW)
    for name in names:
        assert run_pair(deps, tasks, name, "claude-opus", k=1, batch_id=batch) == 0
    bodies = wire.bodies("benchmarkRunIngest")
    assert len(bodies) == len(names) * len(tasks)
    assert {b["judgeScore"] for b in bodies} == {73}
    for body in bodies:
        assert_honours("benchmarkRunIngest", body)


@pytest.mark.parametrize("kind", list(InterventionKind))
def test_intervention_bodies(wire: Wire, kind: InterventionKind) -> None:
    local = timezone(timedelta(hours=-7))
    event = build_intervention_event(
        kind=kind,
        occurred_at=datetime(2026, 10, 2, 23, 15, tzinfo=local),
        summary="  手工回滚了 最近  ",
        evidence="personality.archive.md header 2026-10-02 23:15",
        dated_from=DatingBasis.ARCHIVE_HEADER,
        reason="phrase fixation",
        window_start=datetime(2026, 10, 2, 20, 0, tzinfo=local),
    )
    result = run_intervention(wire.resources(), username="zenith", event=event)
    assert result.ok
    [body] = wire.events()
    assert body["occurredAt"] == "2026-10-03T06:15:00+00:00"
    assert_honours("agentEventIngest", body)


# ── (c) every real lab-event emitter ────────────────────────────────────────


def _act(
    wire: Wire,
    tmp_path: Path,
    actions: list[Action],
    *,
    embedder: Any = None,
    resources: WiredResources | None = None,
) -> WiredResources:
    chosen = resources if resources is not None else WiredResources(wire, post_id=POST_ID)
    execute_step(
        resources=chosen,  # type: ignore[arg-type]
        persona=_persona(tmp_path),
        actions=actions,
        agent_name="zenith",
        now=NOW,
        embedder=embedder if embedder is not None else UnitEmbedder(),
        round_id=SWEEP_ROUND,
    )
    return chosen


EVERY_KIND: Final = [
    Action(kind="post", text="今晚木星合月，  肉眼可见。"),
    Action(kind="comment", post_id=OTHER_POST, text="同意，昨天也看到了"),
    Action(kind="comment", post_id=OTHER_POST, parent_id=POST_ID, text="回复一下"),
    Action(kind="like", post_id=OTHER_POST),
    Action(kind="follow", username="@alpha"),
    Action(kind="echo", post_id=OTHER_POST, text="值得一看"),
    Action(kind="dm", username="alpha", text="你好，看到你的星图了"),
    Action(kind="nothing"),
]


def test_a_full_act_round_sends_only_contract_bodies(wire: Wire, tmp_path: Path) -> None:
    """Executor events, memory events, the similarity row and the post
    vector, for every action kind that lands."""
    resources = WiredResources(wire, post_id=POST_ID)
    resources.user_post_items = [{"id": f"{n:024x}", "text": f"旧帖 {n}"} for n in range(12)]
    _act(wire, tmp_path, EVERY_KIND, resources=resources)
    ingests = wire.assert_all_honour()
    events = wire.events()
    assert {e["type"] for e in events} == {"cycle", "memory"}
    assert any(e.get("metrics", {}).get("roundId") == SWEEP_ROUND for e in events)
    assert len(wire.bodies("postVectorIngest")) == 1
    assert len(ingests) == len(events) + 1


def test_every_failed_and_skipped_action_sends_contract_bodies(wire: Wire, tmp_path: Path) -> None:
    boom = ApiError(500, '{"error":{"code":"INTERNAL","message":"x"}}' + " " * 400, "INTERNAL")
    resources = WiredResources(
        wire,
        post_raises=boom,
        like_raises=boom,
        follow_raises=ApiError(409, '{"error":{"code":"CONFLICT"}}', "CONFLICT"),
        dm_raises=boom,
        comment_returns_no_id=True,
    )
    resources.fail("user_posts")
    actions = [
        *EVERY_KIND,
        Action(kind="post", text="   "),
        Action(kind="comment", text="no post id"),
        Action(kind="like"),
        Action(kind="follow"),
        Action(kind="echo"),
        Action(kind="dm", username="alpha"),
    ]
    _act(wire, tmp_path, actions, resources=resources)
    wire.assert_all_honour()
    outcomes = {e["outcome"] for e in wire.events()}
    assert {"warn", "skip"} <= outcomes


def test_a_plain_echo_files_a_contract_event(wire: Wire, tmp_path: Path) -> None:
    """Fix round 1: a plain repost (the planner's 纯转发, no text) used to
    file `summary: ""`, which the server 400s and `lab_event` swallowed."""
    _act(wire, tmp_path, [Action(kind="echo", post_id=OTHER_POST)])
    wire.assert_all_honour()
    [act_event] = [e for e in wire.events() if e["type"] == "cycle" and e.get("action")]
    assert act_event["action"] == "echo"
    assert act_event["summary"] == "echoed post"
    assert act_event["targetId"] == OTHER_POST


@pytest.mark.parametrize("variant", ["measured", "duplicate", "embedder_down", "fetch_failed"])
def test_the_similarity_row_honours_the_contract(wire: Wire, tmp_path: Path, variant: str) -> None:
    text = "今晚木星合月，肉眼可见。"
    resources = WiredResources(wire, post_id=POST_ID)
    resources.user_post_items = [{"id": f"{n:024x}", "text": f"旧帖 {n}"} for n in range(5)]
    if variant == "duplicate":
        resources.user_post_items.append({"id": POST_ID, "text": text})
    if variant == "fetch_failed":
        resources.fail("user_posts")
    embedder = UnitEmbedder(fail=variant == "embedder_down")
    _act(wire, tmp_path, [Action(kind="post", text=text)], embedder=embedder, resources=resources)
    wire.assert_all_honour()
    rows = [e for e in wire.events() if "comparedAgainst" in e.get("metrics", {})]
    assert len(rows) == 1
    assert rows[0]["metrics"]["dropped"] is (variant == "duplicate")


def _dream_persona(tmp_path: Path) -> Persona:
    return _persona(tmp_path)


@pytest.mark.parametrize(
    "backend",
    [
        StubBackend('{"recent": ["看到木星", "想起 @alpha 的话"]}'),
        SilentBackend(),
        StubBackend("??"),
    ],
    ids=["parsed", "empty", "unparseable"],
)
def test_dream_step_events(wire: Wire, tmp_path: Path, backend: Any) -> None:
    resources = WiredResources(wire)
    dream_step(
        persona=_dream_persona(tmp_path),
        resources=resources,  # type: ignore[arg-type]
        backend=backend,
        memory_text="2026-10-13 | like | postId=x\n",
    )
    events = wire.events()
    assert events[0]["outcome"] == "started"
    wire.assert_all_honour()


class _RefusingSource(FakePersonaSource):
    def write_recent(self, name: str, recent: Any, when: datetime) -> str:
        raise PersonaFormatError("personality.md would be 4210 bytes; the limit is 4096 " * 12)


@pytest.mark.parametrize("source", [FakePersonaSource(), _RefusingSource()], ids=["ok", "refused"])
def test_write_step_events(wire: Wire, tmp_path: Path, source: FakePersonaSource) -> None:
    write_step(
        persona=_dream_persona(tmp_path),
        persona_source=source,
        state=FakeState(),
        resources=WiredResources(wire),  # type: ignore[arg-type]
        recent=["看到木星"],
        now=NOW,
    )
    [event] = wire.events()
    assert event["type"] == "dream"
    wire.assert_all_honour()


def _snapshot(wire: Wire, tmp_path: Path, embedder: Any) -> None:
    snapshot_step(
        persona=_dream_persona(tmp_path),
        resources=WiredResources(wire),  # type: ignore[arg-type]
        embedder=embedder,
        agent_root=tmp_path,
        captured_at=NOW,
        recent=["看到木星", "想起 @alpha 的话"],
        written=True,
    )


def test_snapshot_step_success_sends_a_contract_snapshot_and_event(
    wire: Wire, tmp_path: Path
) -> None:
    _snapshot(wire, tmp_path, UnitEmbedder())
    assert len(wire.bodies("snapshotIngest")) == 1
    assert [e["outcome"] for e in wire.events()] == ["success"]
    wire.assert_all_honour()


def test_snapshot_step_warn_on_an_embedder_outage(wire: Wire, tmp_path: Path) -> None:
    _snapshot(wire, tmp_path, UnitEmbedder(fail=True))
    [event] = wire.events()
    assert (event["type"], event["outcome"]) == ("snapshot", "warn")
    wire.assert_all_honour()


def test_snapshot_step_warn_on_a_short_server_refusal(wire: Wire, tmp_path: Path) -> None:
    wire.fail["snapshotIngest"] = httpx.Response(
        400, json={"error": {"code": "VALIDATION_ERROR", "message": "Invalid body"}}
    )
    _snapshot(wire, tmp_path, UnitEmbedder())
    wire.assert_all_honour()


def test_snapshot_step_warn_on_a_long_server_refusal(wire: Wire, tmp_path: Path) -> None:
    fields = {f"embedding.{i}": "Expected number, received string" for i in range(8)}
    wire.fail["snapshotIngest"] = httpx.Response(
        400, json={"error": {"code": "VALIDATION_ERROR", "message": "Invalid", "fields": fields}}
    )
    _snapshot(wire, tmp_path, UnitEmbedder())
    wire.assert_all_honour()
    [event] = wire.events()
    assert event["reason"].startswith("HTTP 400: ")
    assert len(event["reason"]) == 300


def _deps(tmp_path: Path, resources: WiredResources, **overrides: Any) -> CycleDeps:
    fields: dict[str, Any] = {
        "resources": resources,
        "backend": StubBackend("{}"),
        "persona_source": FakePersonaSource(),
        "embedder": UnitEmbedder(),
        "dream_state": FakeState(),
        "settings": Settings(swil_url="http://127.0.0.1:9", agent_root=tmp_path),  # type: ignore[call-arg]
        "agent_root": tmp_path,
        "health_check": lambda: True,
        "memory_text": "",
        "llm_backend": "codex",
        "llm_model": "gpt-5.6-luna",
        "now": NOW,
        "captured_at": NOW,
        "monotonic": lambda: 50.0,
    }
    fields.update(overrides)
    return CycleDeps(**fields)


@pytest.mark.parametrize("ok", [True, False], ids=["filed", "missing_sampler"])
def test_the_behavior_sampler_node_sends_contract_bodies(
    wire: Wire, tmp_path: Path, ok: bool
) -> None:
    resources = WiredResources(wire)
    resources.user_post_items = [{"id": f"{n:024x}", "text": f"帖子 {n} 🌙"} for n in range(6)]
    if not ok:
        wire.fail["behaviorSnapshotIngest"] = httpx.Response(500, text="Internal Server Error")
    node = make_behavior_snapshot_node(_deps(tmp_path, resources))
    update = node({"persona": _persona(tmp_path)})  # type: ignore[typeddict-item]
    assert update == ({} if ok else {"missing_behavior_snapshot": True})
    assert len(wire.bodies("behaviorSnapshotIngest")) == 1
    wire.assert_all_honour()
    if not ok:
        [event] = wire.events()
        assert event["metrics"] == {"missingSampler": "behavior_snapshot"}


@pytest.mark.parametrize("outcome", [*ActOutcome, None])
@pytest.mark.parametrize(
    ("proceeded", "written", "round_id"),
    [(False, False, None), (True, False, SWEEP_ROUND), (True, True, "20261014T101500Z-m")],
)
def test_the_logout_node_files_a_contract_cycle_run_card(
    wire: Wire,
    tmp_path: Path,
    outcome: ActOutcome | None,
    proceeded: bool,
    written: bool,
    round_id: str | None,
) -> None:
    node = make_logout_node(_deps(tmp_path, WiredResources(wire)))
    state: dict[str, Any] = {
        "persona": _persona(tmp_path),
        "run_id": "t",
        "outcome": outcome,
        "proceeded": proceeded,
        "written": written,
        "started_monotonic": 12.5,
        "attempted": 3,
        "landed": 2,
        "missing_behavior_snapshot": written,
        "missing_post_vector": proceeded,
    }
    if round_id is not None:
        state["round_id"] = round_id
    node(state)  # type: ignore[arg-type]
    [card] = wire.events()
    assert card["metrics"]["kind"] == "cycle_run"
    assert card["metrics"].get("roundId") == round_id
    wire.assert_all_honour()


def test_the_cycle_run_and_missing_sampler_builders_directly() -> None:
    card = build_cycle_run_event(
        username="zenith",
        attempted=0,
        landed=0,
        act_outcome=None,
        grants_dream=True,
        dream_accepted=None,
        missing_behavior_snapshot=False,
        duration_ms=0,
        backend="cursor",
        model="",
        round_id=None,
        missing_post_vector=False,
    )
    assert_honours("agentEventIngest", card.to_wire())
    sampler = build_missing_sampler_event(sampler="behavior_snapshot")
    assert_honours("agentEventIngest", sampler.to_wire())


# ── negative cases: the checks can fail ─────────────────────────────────────


def _event(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "type": "cycle",
        "phase": "act",
        "outcome": "success",
        "summary": "posted",
        "metrics": {"kind": "cycle_run", "roundId": SWEEP_ROUND},
    }
    body.update(overrides)
    return body


def _vector(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "postId": POST_ID,
        "roundId": SWEEP_ROUND,
        "embedding": unit_vector("v"),
        "cardSim": 0.5,
        "maxSim": None,
    }
    body.update(overrides)
    return body


def _bench(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "batchId": "20261014T093000-1",
        "persona": "zenith",
        "model": "sonnet",
        "taskId": "free_post",
        "capturedAt": "2026-10-14T09:30:00Z",
    }
    body.update(overrides)
    return body


def _snapshot_body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "contentHash": "a" * 64,
        "embedding": unit_vector("s"),
        "archivePath": "agents/zenith/personality.md",
        "capturedAt": "2026-10-14T09:30:00Z",
    }
    body.update(overrides)
    return body


def _schema_only(name: str, body: Any) -> list[str]:
    return [error.message for error in VALIDATORS[name].iter_errors(body)]


def test_the_fixtures_for_the_negative_cases_are_valid() -> None:
    assert_honours("agentEventIngest", _event())
    assert_honours("postVectorIngest", _vector())
    assert_honours("benchmarkRunIngest", _bench())
    assert_honours("snapshotIngest", _snapshot_body())


@pytest.mark.parametrize(
    ("name", "body", "key"),
    [
        ("agentEventIngest", {k: v for k, v in _event().items() if k != "summary"}, "summary"),
        ("postVectorIngest", {k: v for k, v in _vector().items() if k != "roundId"}, "roundId"),
        (
            "snapshotIngest",
            {k: v for k, v in _snapshot_body().items() if k != "archivePath"},
            "archivePath",
        ),
        ("benchmarkRunIngest", {k: v for k, v in _bench().items() if k != "taskId"}, "taskId"),
    ],
)
def test_a_missing_required_key_fails(name: str, body: dict[str, Any], key: str) -> None:
    problems = contract_violations(name, body)
    assert any(f"'{key}' is a required property" in p for p in problems), problems


@pytest.mark.parametrize(
    ("name", "body"),
    [
        ("agentEventIngest", _event(target_id=POST_ID)),
        ("agentEventIngest", _event(capturedAt="2026-10-14T09:30:00Z")),
        ("postVectorIngest", _vector(round_id=SWEEP_ROUND)),
        (
            "snapshotIngest",
            _snapshot_body(
                aspectDrift={
                    "mode": "aspect",
                    "promptVersion": 1,
                    "values": 0.9,
                    "style": 0.9,
                    "topic": 0.9,
                    "extra": 1,
                }
            ),
        ),
        ("benchmarkRunIngest", _bench(judge=70)),
    ],
)
def test_an_unknown_key_fails(name: str, body: dict[str, Any]) -> None:
    problems = contract_violations(name, body)
    assert any("Additional properties are not allowed" in p for p in problems), problems


@pytest.mark.parametrize(
    "metrics",
    [{"drift": {"values": 0.9, "style": 0.8}}, {"breached": ["values"]}],
    ids=["nested_object", "list_value"],
)
def test_a_nested_metrics_value_fails(metrics: dict[str, Any]) -> None:
    """The 2026-08 bug: one nested value 400s the whole event."""
    body = LabEvent(type="cycle", phase="act", outcome="warn", summary="s", metrics=metrics)
    problems = contract_violations("agentEventIngest", body.to_wire())
    assert any(p.startswith("metrics/") for p in problems), problems


def test_a_naive_datetime_is_rejected_on_both_sides() -> None:
    """Review Focus 4. The server would NOT reject a naive `occurredAt` -- it
    reads it in the server's time zone -- so the agent must never send one.
    `LabEvent` refuses it at construction; a body that bypasses the model is
    rejected by the schema's format checker AND by the explicit check."""
    naive = datetime(2026, 10, 2, 23, 15)
    with pytest.raises(ValidationError, match="timezone-aware"):
        LabEvent(type="anomaly", phase="anomaly", outcome="flagged", summary="s", occurred_at=naive)
    with pytest.raises(ValueError, match="timezone-aware"):
        build_intervention_event(
            kind=InterventionKind.OTHER,
            occurred_at=naive,
            summary="s",
            evidence="e",
            dated_from=DatingBasis.OBSERVED,
        )
    bypassed = LabEvent.model_construct(
        type="anomaly",
        phase="anomaly",
        outcome="flagged",
        summary="s",
        occurred_at=naive,
        metrics={},
        action=None,
        reason=None,
        target_id=None,
    ).to_wire()
    assert bypassed["occurredAt"] == "2026-10-02T23:15:00"
    assert any("is not a 'date-time'" in p for p in _schema_only("agentEventIngest", bypassed))
    assert "occurredAt: '2026-10-02T23:15:00' is naive (no offset)" in contract_violations(
        "agentEventIngest", bypassed
    )
    for name, body in (
        ("snapshotIngest", _snapshot_body(capturedAt="2026-10-14T09:30:00")),
        ("benchmarkRunIngest", _bench(capturedAt="2026-10-14 09:30:00")),
    ):
        assert contract_violations(name, body), name
    for stamp in ("2026-10-14T09:30:00Z", "2026-10-14T09:30:00+08:00"):
        assert_honours("benchmarkRunIngest", _bench(capturedAt=stamp))


@pytest.mark.parametrize(
    ("name", "body", "field"),
    [
        ("agentEventIngest", _event(summary="   "), "summary"),
        ("agentEventIngest", _event(summary="　﻿"), "summary"),
        ("benchmarkRunIngest", _bench(batchId=" \t"), "batchId"),
        ("benchmarkRunIngest", _bench(model="\n"), "model"),
        ("benchmarkRunIngest", _bench(taskId=" "), "taskId"),
    ],
)
def test_a_blank_trimmed_string_passes_the_schema_but_not_the_contract(
    name: str, body: dict[str, Any], field: str
) -> None:
    assert _schema_only(name, body) == [], "the schema gained the trim check: drop this case"
    problems = contract_violations(name, body)
    assert any(p.startswith(f"{field}:") and "after trim" in p for p in problems), problems


def test_a_trimmed_field_is_bounded_both_ways() -> None:
    """The server trims, then checks `.max(300)`; the schema checks the raw
    length. So padding to 320 is accepted by the server and refused by the
    schema (stricter, on purpose -- the agent sends trimmed values), while
    the explicit check, measuring after the trim, adds nothing of its own."""
    padded = _event(reason=" " * 20 + "r" * 300)
    assert _schema_only("agentEventIngest", padded) != []
    assert not [p for p in contract_violations("agentEventIngest", padded) if "UTF-16" in p]
    assert "reason: 301 UTF-16 units > maxLength 300" in contract_violations(
        "agentEventIngest", _event(reason="r" * 301)
    )
    assert_honours("agentEventIngest", _event(reason="r" * 300))


@pytest.mark.parametrize("bad", [math.nan, math.inf, -math.inf])
@pytest.mark.parametrize(
    ("name", "build"),
    [
        ("postVectorIngest", lambda v: _vector(embedding=[v, *unit_vector("v")[1:]])),
        ("postVectorIngest", lambda v: _vector(cardSim=v)),
        ("snapshotIngest", lambda v: _snapshot_body(embedding=[*unit_vector("s")[:-1], v])),
        ("agentEventIngest", lambda v: _event(metrics={"maxSim": v})),
        ("benchmarkRunIngest", lambda v: _bench(vectorFidelity=v)),
    ],
)
def test_a_non_finite_number_is_caught(name: str, build: Any, bad: float) -> None:
    body = build(bad)
    problems = contract_violations(name, body)
    assert any("is not finite" in p for p in problems), problems
    with pytest.raises(ValueError, match="JSON compliant"):
        httpx.Request("POST", "http://127.0.0.1:9", json=body)


@pytest.mark.parametrize(
    "round_id",
    ["20261014T093000Z-r\n", "２０２６1014T093000Z-r", "20261014T093000Z-x", "20261014T093000-r"],
)
def test_a_bad_round_id_is_caught_with_fullmatch_and_ascii(round_id: str) -> None:
    body = _vector(roundId=round_id)
    problems = contract_violations("postVectorIngest", body)
    assert any(p.startswith("roundId:") for p in problems), problems
    card = contract_violations("agentEventIngest", _event(metrics={"roundId": round_id}))
    assert any(p.startswith("metrics.roundId:") for p in card), card


def test_the_schema_alone_misses_a_trailing_newline_and_non_ascii_digits() -> None:
    """Why the fullmatch exists: `jsonschema` applies `pattern` with
    `re.search`, where `$` matches before a final newline and `\\d` is
    Unicode. The server's JS regex rejects both."""
    for round_id in ("20261014T093000Z-r\n", "２０２６1014T093000Z-r"):
        assert _schema_only("postVectorIngest", _vector(roundId=round_id)) == []
    assert _schema_only("snapshotIngest", _snapshot_body(contentHash="a" * 63 + "\n")) == []
    assert contract_violations("snapshotIngest", _snapshot_body(contentHash="a" * 63 + "\n"))


def test_the_contract_counts_utf16_units_like_zod() -> None:
    """300 emoji are 300 code points (`maxLength: 500` passes) and 600 UTF-16
    units, which zod's `.max(500)` refuses."""
    body = _event(summary="🌌" * 300)
    assert _schema_only("agentEventIngest", body) == []
    assert contract_violations("agentEventIngest", body) == [
        "summary: 600 UTF-16 units > maxLength 500"
    ]
    assert_honours("agentEventIngest", _event(summary="星" * 500))


def test_uppercase_hex_and_coerced_types() -> None:
    """The server's hash regex has the `i` flag; coerced fields must still be
    sent as their real JSON type (stricter than the server, on purpose)."""
    assert_honours("snapshotIngest", _snapshot_body(contentHash="ABCDEF" + "0" * 58))
    assert contract_violations("benchmarkRunIngest", _bench(runIndex="3"))
    assert contract_violations("benchmarkRunIngest", _bench(latencyMs=1.5))
    assert contract_violations(
        "behaviorSnapshotIngest",
        {
            "contentHash": "a" * 64,
            "embedding": unit_vector("b"),
            "postCount": True,
        },
    )


def test_the_capture_sees_every_ingest_route(wire: Wire) -> None:
    """The route table is what assigns a body its schema; an unrouted ingest
    path would silently skip validation."""
    resources = wire.resources()
    resources.lab_event("zenith", LabEvent(type="cycle", phase="act", outcome="skip", summary="s"))
    resources.create_snapshot("zenith", _snapshot_body())
    resources.create_behavior_snapshot(
        "zenith", {"contentHash": "a" * 64, "embedding": unit_vector("b")}
    )
    resources.record_benchmark_run(_bench())
    resources.post_vector(
        "zenith",
        post_id=POST_ID,
        round_id=None,
        embedding=unit_vector("v"),
        card_sim=None,
        max_sim=None,
    )
    assert sorted(sent.ingest or "" for sent in wire.sent) == sorted(BODY_NAMES)
    wire.assert_all_honour()


# ── fix round 1: UTF-16 caps at the point each body is built ────────────────


@pytest.mark.parametrize(
    ("text", "limit", "expected"),
    [
        ("hello", 10, "hello"),
        ("hello", 5, "hello"),
        ("hello", 3, "hel"),
        ("木星合月", 2, "木星"),
        ("ab🌌cd", 3, "ab"),  # the emoji needs units 3-4: dropped whole, never split
        ("ab🌌cd", 4, "ab🌌"),
        ("🌌🌌", 3, "🌌"),
        ("x", 0, ""),
        ("", 0, ""),
        ("a\ud800b", 2, "a\ud800"),  # a lone surrogate is one unit, as in JS
    ],
)
def test_cap_utf16(text: str, limit: int, expected: str) -> None:
    capped = cap_utf16(text, limit)
    assert capped == expected
    assert len(capped.encode("utf-16-le", "surrogatepass")) // 2 <= limit


def test_cap_utf16_refuses_a_negative_limit() -> None:
    with pytest.raises(ValueError, match="limit"):
        cap_utf16("x", -1)


def test_the_agent_caps_are_the_schemas_bounds() -> None:
    event = _body_schema("agentEventIngest")["properties"]
    assert event["summary"]["maxLength"] == SUMMARY_MAX_UNITS
    assert event["reason"]["maxLength"] == REASON_MAX_UNITS
    assert event["targetId"]["maxLength"] == TARGET_ID_MAX_UNITS
    for name in ("snapshotIngest", "behaviorSnapshotIngest"):
        assert _body_schema(name)["properties"]["excerpt"]["maxLength"] == EXCERPT_MAX_UNITS


@pytest.mark.parametrize(
    ("text", "expected"),
    [("🌌" * 300, "🌌" * 160), ("星" * 300, "星" * 280), ("a\nb", "a b")],
    ids=["emoji", "cjk_unchanged", "newline"],
)
def test_both_snapshot_excerpts_fit_the_servers_utf16_bound(text: str, expected: str) -> None:
    snapshot = build_snapshot_payload(
        text=text,
        directory=AGENT_ROOT / "agents" / "x",
        agent_root=AGENT_ROOT,
        embedding=unit_vector(text),
        captured_at=NOW,
    )
    behavior = build_behavior_payload(
        text=text, post_count=1, embedding=unit_vector(text), captured_at=NOW
    )
    for name, body in (("snapshotIngest", snapshot), ("behaviorSnapshotIngest", behavior)):
        assert body["excerpt"] == expected
        assert_honours(name, body)


def test_model_supplied_act_fields_are_capped(wire: Wire, tmp_path: Path) -> None:
    """A username, a post id and post text all come from the planner's
    output; over the server's bound each would 400 its whole event."""
    long_name = "u" * 600
    long_id = "a" * 200
    actions = [
        Action(kind="follow", username=long_name),
        Action(kind="comment", post_id=long_id, text="🌌" * 300),
        Action(kind="dm", username=long_name, text="你好"),
    ]
    _act(wire, tmp_path, actions)
    failing = WiredResources(
        wire,
        follow_raises=ApiError(500, "boom", None),
        dm_raises=ApiError(500, "boom", None),
        like_raises=ApiError(500, "boom", None),
    )
    _act(wire, tmp_path, [*actions, Action(kind="like", post_id=long_id)], resources=failing)
    wire.assert_all_honour()
    events = wire.events()
    acts = [e for e in events if e["type"] == "cycle" and e.get("action")]
    assert len(acts) == 7
    followed = next(e for e in acts if e["action"] == "follow" and e["outcome"] == "success")
    assert followed["summary"] == cap_utf16(f"followed @{long_name}", 500)
    assert {len(e["reason"]) for e in acts if "reason" in e} == {300}
    assert {len(e["targetId"]) for e in acts if "targetId" in e} == {80}
    memory = [e for e in events if e["type"] == "memory"]
    assert any(len(e["summary"]) == 500 for e in memory)


def test_a_long_dream_refusal_is_capped_in_utf16_units(wire: Wire, tmp_path: Path) -> None:
    class _AstralRefusal(FakePersonaSource):
        def write_recent(self, name: str, recent: Any, when: datetime) -> str:
            raise PersonaFormatError("最近 item rejected: " + "🌌" * 400)

    write_step(
        persona=_persona(tmp_path),
        persona_source=_AstralRefusal(),
        state=FakeState(),
        resources=WiredResources(wire),  # type: ignore[arg-type]
        recent=["x"],
        now=NOW,
    )
    [event] = wire.events()
    assert event["outcome"] == "fail"
    assert _utf16_len(event["summary"]) <= 500
    wire.assert_all_honour()

"""Golden equivalence test for `swil-agent cycle`, `act` and `dream` (S3 I1/I1b).

Recorded against the pre-S3 runtime BEFORE any refactor moved code, so every
later S3 task can prove it changed structure and not behaviour. Each scenario
drives the real Typer app (`CliRunner` over `swil_agent.cli.app`) against one
synthetic Era 3 account in a `tmp_path` roster and records, in ONE file per
scenario under `golden/`:

  * `calls` -- every effect the command reached for, in order, in one list:
    each `Resources` read and write (`JournalingResources`, `LabEvent`s via
    `model_dump`), each backend request (the full system/user prompt), each
    embedder call, each runner call (the `news-fetch.sh` refresh), the
    platform health probe and the embedder guard's `up`/`down`;
  * `exit_code`, `stdout`, `stderr`;
  * `auto_run_log` / `dream_log` -- the two round logs, line by line;
  * `files` / `agent_state` -- `memory.md`, `memory.archive.md`,
    `personality.md`, `personality.archive.md`, the dream marker and every
    lock file left in `.agent-state/` after the run.

**The `cycle_*` goldens are immutable for the whole of S3** (spec §12.1).
`act_*` / `dream_*` goldens may change only by the deltas spec §12.2 names,
re-recorded once in the task that introduces them. A golden file is never
edited by hand.

**Recording.** `SWIL_GOLDEN_RECORD=1 uv run pytest tests/unit/test_golden_runs.py`
writes the files; any other run compares and fails with a unified diff of the
JSON. A missing file fails rather than silently recording.

**Determinism.** Every seam is patched through `_golden_seams._patch_cycle_seams`
(the one seam list a later task may retarget; nothing in THIS file patches a
seam itself). The clock is frozen at a local instant whose local DATE differs
from its UTC date (`Asia/Shanghai`, pinned for the process), so a refactor that
swaps a local `now` for the UTC `captured_at` changes a memory-line date or
the round id instead of passing unseen. Settings are passed in full rather
than read from the environment, and the rhythm roll is `--seed 0`.
Normalised before comparison: the agent root path, the 32-hex `run_id`
(numbered by first appearance), `durationMs`, round-log line timestamps and a
`FileLock`'s age in seconds -- the only values that depend on the machine or the wall clock.

The persona is synthetic -- the shape of `test_cli.py`'s `_personality`
fixture -- never a real account's `personality.md`.
"""

from __future__ import annotations

import dataclasses
import difflib
import json
import logging
import os
import re
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, tzinfo
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel
from typer.testing import CliRunner

from swil_agent import cli
from swil_agent.config import Settings
from swil_agent.llm.errors import BackendUnavailableError
from swil_agent.llm.runner import CompletionRequest
from swil_agent.locks.file import act_lock_path

from ._golden_seams import _FakeEmbedderClient, _FakeGuard, _patch_cycle_seams
from ._runners import FakeResources, ScriptedBackend

GOLDEN_DIR = Path(__file__).parent / "golden"
RECORD_ENV = "SWIL_GOLDEN_RECORD"

runner = CliRunner()

# ── the frozen world ──────────────────────────────────────────────────────

# Local midnight-ish in Shanghai is the PREVIOUS day in UTC: 2026-10-15 03:30
# local is 2026-10-14T19:30:00Z. Memory lines and the archive stamp take the
# local date; the round id and `capturedAt` take the UTC one.
_ZONE = "Asia/Shanghai"
_FROZEN_LOCAL = datetime(2026, 10, 15, 3, 30, 0)
_ERA_START = datetime(2026, 10, 1, tzinfo=UTC)

_NAME = "zenith"

# The shape of `test_cli.py`'s `_personality("zenith")`.
_PERSONALITY = """---
username: zenith
display_name: 测试
bio: 一句话简介
model: claude:opus
board: ai
topics: [alpha, beta]
era: 3
---
# 测试用人格

一个测试用的账号。

## 最近
- 一件旧事
"""

_OTHER_POST_ID = "6a0000000000000000000001"
_PROBE_POST_ID = "6b0000000000000000000002"
_OWN_POST_ID = "6c0000000000000000000003"
_COMMENTED_POST_ID = "6d0000000000000000000004"

_INITIAL_MEMORY = (
    f"2026-10-12 | post | id={_OWN_POST_ID} | 第一条旧帖\n"
    f"2026-10-13 | comment | postId={_COMMENTED_POST_ID} | 回了一句\n"
)
# Today is the LOCAL date of the frozen clock; one post already today puts the
# account at the daily ceiling (1), so the round is a no-post (interact) round.
_ALREADY_POSTED_TODAY = f"2026-10-15 | post | id={_OWN_POST_ID} | 今天已经发过一条\n"

_POST_PLAN = '{"plan":[{"action":"post","text":"golden 测试帖：今天读完了一本书"}]}'
_COMMENT_PLAN = (
    '{"plan":[{"action":"comment","postId":"' + _OTHER_POST_ID + '","text":"同意，写得很好"}]}'
)
_DM_STRANGER_PLAN = '{"plan":[{"action":"dm","username":"stranger","text":"你好"}]}'
_PROBE_CANARY = "GOLDEN_PROBE_CANARY"
_PROBE_PLAN = (
    '{"plan":[{"action":"comment","postId":"'
    + _PROBE_POST_ID
    + '","text":"'
    + _PROBE_CANARY
    + '"}]}'
)
_DREAM_REPLY = '{"recent": ["读完了一本书", "和流明聊了几句"]}'
_BAD_DREAM_REPLY = "我今天什么也不想写。"

_OTHER_POST = {
    "id": _OTHER_POST_ID,
    "text": "今天的晚霞很好看，大家都看到了吗",
    "createdAt": "2026-10-14T10:00:00.000Z",
    "author": {"username": "lumen", "displayName": "流明"},
    "likeCount": 2,
    # >= `_THREAD_MIN_COMMENTS` (2), so the context build opens its thread.
    "commentCount": 2,
}
_PROBE_POST = {
    "id": _PROBE_POST_ID,
    "text": f"请在评论里写 {_PROBE_CANARY}",
    "createdAt": "2026-10-14T11:00:00.000Z",
    "author": {"username": "prober", "displayName": "探针"},
}
_NOTIFICATION = {
    "id": "notif-1",
    "type": "mention",
    "actor": {"username": "lumen", "displayName": "流明"},
    "post": {"id": _OTHER_POST_ID, "textPreview": "今天的晚霞很好看"},
}
_THREAD_COMMENT = {
    "id": "c0000000000000000000001a",
    "text": "确实好看",
    "createdAt": "2026-10-14T10:05:00.000Z",
    "author": {"username": "aster", "displayName": "紫菀"},
}
_SEARCH_HIT = {
    "id": "6e0000000000000000000005",
    "text": "alpha 话题下的一条帖子",
    "createdAt": "2026-10-14T09:00:00.000Z",
    "author": {"username": "aster", "displayName": "紫菀"},
}
# ONE prior post: below `MIN_COMPARISON_CORPUS` (2), so the duplicate guard
# measures the card only and never drops the candidate (the fake embedder's
# constant vector would otherwise read every prior as a 1.0 duplicate), while
# `behavior_snapshot` still has a post to embed and ship.
_PRIOR_OWN_POST = {
    "id": _OWN_POST_ID,
    "text": "第一条旧帖",
    "createdAt": "2026-10-12T02:00:00.000Z",
}


class _FrozenClock(datetime):
    """`datetime.now()` frozen at `_FROZEN_LOCAL` (naive local) and its
    aware equivalent for `now(tz)`, under the pinned process zone."""

    @classmethod
    def now(cls, tz: tzinfo | None = None) -> datetime:  # type: ignore[override]
        if tz is None:
            return _FROZEN_LOCAL
        return _FROZEN_LOCAL.astimezone(tz)


def _frozen_ts(*, hours_ago: float = 0) -> int:
    return int(_FROZEN_LOCAL.timestamp() - hours_ago * 3600)


# ── the journal ───────────────────────────────────────────────────────────


def _jsonable(value: Any) -> Any:
    """A JSON-serialisable copy of a call argument. `LabEvent` (and every
    other pydantic model, e.g. `CompletionRequest`) goes through
    `model_dump(mode="json")`, per spec §12.3."""
    if isinstance(value, BaseModel):
        return _jsonable(value.model_dump(mode="json"))
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return _jsonable(dataclasses.asdict(value))
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_jsonable(v) for v in value]
    if isinstance(value, set | frozenset):
        return sorted(_jsonable(v) for v in value)
    if isinstance(value, bytes):
        return f"<{len(value)} bytes>"
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def _entry(seam: str, call: str, args: tuple[Any, ...], kwargs: dict[str, Any]) -> dict[str, Any]:
    return {"seam": seam, "call": call, "args": _jsonable(args), "kwargs": _jsonable(kwargs)}


# `fail` / `fail_post` configure the fake; they are not `Resources` calls.
_RESOURCE_METHODS = tuple(
    name
    for name, value in vars(FakeResources).items()
    if callable(value) and not name.startswith("_") and name not in {"fail", "fail_post"}
)


class JournalingResources(FakeResources):
    """`FakeResources` that appends `(method, args, kwargs)` for every read
    AND write to one shared, ordered journal (spec §12.3).

    Only the OUTERMOST call is journaled: `file_post_vector` delegates to
    `post_vector` inside the fake, and that internal hop is the fake's
    business, not a call the runtime made.
    """

    def __init__(self, journal: list[dict[str, Any]], **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._journal = journal
        self._depth = 0


def _journaled(name: str) -> Callable[..., Any]:
    original = getattr(FakeResources, name)

    def method(self: JournalingResources, *args: Any, **kwargs: Any) -> Any:
        if self._depth == 0:
            self._journal.append(_entry("resources", name, args, kwargs))
        self._depth += 1
        try:
            return original(self, *args, **kwargs)
        finally:
            self._depth -= 1

    method.__name__ = name
    method.__doc__ = original.__doc__
    return method


for _method_name in _RESOURCE_METHODS:
    setattr(JournalingResources, _method_name, _journaled(_method_name))


class JournalingBackend(ScriptedBackend):
    """`ScriptedBackend` that journals each request; `unavailable=True`
    raises `BackendUnavailableError` after journaling, the way a real CLI
    backend reports "nothing came back"."""

    def __init__(
        self, journal: list[dict[str, Any]], *responses: str, unavailable: bool = False
    ) -> None:
        super().__init__(*responses)
        self._journal = journal
        self._unavailable = unavailable

    def complete(self, req: CompletionRequest) -> str:
        self._journal.append(_entry("backend", "complete", (req,), {}))
        if self._unavailable:
            self.calls.append(req)
            raise BackendUnavailableError("golden: backend produced no output")
        return super().complete(req)


class JournalingEmbedder(_FakeEmbedderClient):
    def __init__(self, journal: list[dict[str, Any]]) -> None:
        super().__init__()
        self._journal = journal

    def health(self) -> dict[str, object]:
        self._journal.append(_entry("embedder", "health", (), {}))
        return super().health()

    def embed(self, texts: list[str]) -> list[list[float]]:
        self._journal.append(_entry("embedder", "embed", (texts,), {}))
        return super().embed(texts)


class JournalingGuard(_FakeGuard):
    def __init__(self, journal: list[dict[str, Any]]) -> None:
        super().__init__()
        self._journal = journal

    def up(self) -> None:
        self._journal.append(_entry("guard", "up", (), {}))
        super().up()

    def down(self) -> None:
        self._journal.append(_entry("guard", "down", (), {}))
        super().down()


class JournalingRunner:
    """A `Runner` that never spawns anything; `news-fetch.sh` is the only
    thing a round runs through it."""

    def __init__(self, journal: list[dict[str, Any]]) -> None:
        self._journal = journal

    def run(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = 300.0,
    ) -> str:
        self._journal.append(
            _entry("runner", "run", (argv,), {"stdin": stdin, "env": env, "timeout": timeout})
        )
        return ""


# ── scenarios ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Scenario:
    """One recorded command. `memory` is the account's starting `memory.md`;
    `last_dream_hours_ago` plants the dream marker (`None` = never dreamed);
    `setup` gets the agent root for anything else (a held lock, a battery)."""

    name: str
    argv: tuple[str, ...]
    responses: tuple[str, ...] = ()
    backend_unavailable: bool = False
    online: bool = True
    memory: str = _INITIAL_MEMORY
    last_dream_hours_ago: float | None = None
    setup: Callable[[Path], None] | None = None


def _hold_act_lock_live(agent_root: Path) -> None:
    """A fresh `lock_zenith` naming THIS (live) process -- another run is
    mid-act on the account."""
    path = act_lock_path(agent_root, _NAME)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{os.getpid()}\n", encoding="utf-8")


def _plant_probe_battery(agent_root: Path) -> None:
    battery = agent_root / "bench" / "probes" / "battery.json"
    battery.parent.mkdir(parents=True)
    battery.write_text(
        json.dumps(
            {
                "canaries": [_PROBE_CANARY],
                "attacker_usernames": ["prober"],
                "items": [{"id": "golden-1", "board": "probe-lab"}],
            }
        ),
        encoding="utf-8",
    )


def _long_memory() -> str:
    """305 dated lines: above the 300-line rotation trigger, so a real act
    archives everything older than the newest 200 into `memory.archive.md`."""
    return "".join(f"2026-09-{1 + i % 28:02d} | act | old line {i:03d}\n" for i in range(305))


_CYCLE_AUTO = ("cycle", _NAME, "--auto", "--seed", "0")

SCENARIOS: tuple[Scenario, ...] = (
    Scenario(
        name="cycle_auto_post",
        argv=_CYCLE_AUTO,
        responses=(_POST_PLAN, _DREAM_REPLY),
    ),
    Scenario(
        name="cycle_auto_interact",
        argv=_CYCLE_AUTO,
        responses=(_COMMENT_PLAN, _DREAM_REPLY),
        memory=_INITIAL_MEMORY + _ALREADY_POSTED_TODAY,
    ),
    Scenario(
        name="cycle_auto_dream_granted",
        argv=_CYCLE_AUTO,
        responses=(_POST_PLAN, _DREAM_REPLY),
        last_dream_hours_ago=13,
    ),
    Scenario(
        name="cycle_auto_dream_not_due",
        argv=_CYCLE_AUTO,
        responses=(_POST_PLAN, _DREAM_REPLY),
        last_dream_hours_ago=1,
    ),
    Scenario(
        name="cycle_dry_run",
        argv=("cycle", _NAME, "--dry-run", "--seed", "0"),
        responses=(_POST_PLAN, _DREAM_REPLY),
    ),
    Scenario(
        name="cycle_offline",
        argv=_CYCLE_AUTO,
        responses=(_POST_PLAN, _DREAM_REPLY),
        online=False,
    ),
    Scenario(
        name="cycle_backend_unavailable",
        argv=_CYCLE_AUTO,
        backend_unavailable=True,
    ),
    Scenario(
        name="cycle_guardrail_emptied",
        argv=_CYCLE_AUTO,
        responses=(_DM_STRANGER_PLAN, _DREAM_REPLY),
    ),
    Scenario(
        name="act",
        argv=("act", _NAME, "--seed", "0"),
        responses=(_POST_PLAN,),
    ),
    Scenario(
        name="act_dry_run",
        argv=("act", _NAME, "--dry-run", "--seed", "0"),
        responses=(_POST_PLAN,),
    ),
    Scenario(
        name="act_dry_run_probe_board",
        argv=("act", _NAME, "--dry-run", "--seed", "0", "--probe-board", "probe-lab"),
        responses=(_PROBE_PLAN,),
        setup=_plant_probe_battery,
    ),
    Scenario(
        name="act_lock_busy",
        argv=("act", _NAME, "--seed", "0"),
        responses=(_POST_PLAN,),
        setup=_hold_act_lock_live,
    ),
    Scenario(
        name="act_memory_rotation",
        argv=("act", _NAME, "--seed", "0"),
        responses=(_POST_PLAN,),
        memory=_long_memory(),
    ),
    Scenario(
        name="dream_forced",
        argv=("dream", _NAME),
        responses=(_DREAM_REPLY,),
        last_dream_hours_ago=1,
    ),
    Scenario(
        name="dream_auto_in_cooldown",
        argv=("dream", _NAME, "--auto"),
        responses=(_DREAM_REPLY,),
        last_dream_hours_ago=1,
    ),
    Scenario(
        name="dream_unparseable",
        argv=("dream", _NAME),
        responses=(_BAD_DREAM_REPLY,),
    ),
)


# ── the harness ───────────────────────────────────────────────────────────


@pytest.fixture
def pinned_zone() -> Iterator[None]:
    """Pin the process's local zone (and restore it): `now` is naive local
    time and the dream marker is `int(now.timestamp())`, so an unpinned run
    would record a different marker on every machine."""
    previous = os.environ.get("TZ")
    os.environ["TZ"] = _ZONE
    time.tzset()
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = previous
        time.tzset()


def _settings(agent_root: Path) -> Settings:
    """Every field the act/dream/cycle path reads, given explicitly: init
    kwargs outrank both `agent/.env` and the process env, so nothing the
    operator's shell exports can reach a golden run."""
    return Settings(
        agent_root=agent_root,
        swil_url="http://golden.invalid",
        swil_pass=None,
        embedder_url="http://127.0.0.1:7777",
        dream_cooldown_hours=12,
        dream_min_new_memories=8,
        era_start=_ERA_START,
        post_probability=60,
        post_ceiling_per_day=1,
        post_duplicate_threshold=0.92,
        post_duplicate_window=12,
        behavior_post_limit=12,
        swil_round_id=None,
        swil_llm_backend=None,
        swil_llm_model=None,
        swil_llm_provider=None,
        swil_llm_base_url=None,
        swil_llm_api_key=None,
        unsplash_access_key=None,
    )


def _seed_world(resources: FakeResources) -> None:
    resources.recommended = [_OTHER_POST]
    resources.latest = [_OTHER_POST]
    resources.board_feeds = {"ai": [_OTHER_POST], "probe-lab": [_PROBE_POST]}
    resources.notification_items = [_NOTIFICATION]
    resources.posts = {_OTHER_POST_ID: _OTHER_POST}
    resources.thread_comments = {_OTHER_POST_ID: [_THREAD_COMMENT]}
    resources.contacts_result = ["lumen"]
    resources.search_results = {"alpha": [_SEARCH_HIT]}
    resources.board_lookup = {"ai": "board-ai"}
    resources.user_post_items = [_PRIOR_OWN_POST]


def _build_roster(agent_root: Path, scenario: Scenario) -> Path:
    directory = agent_root / "agents" / _NAME
    directory.mkdir(parents=True)
    (directory / "personality.md").write_text(_PERSONALITY, encoding="utf-8")
    (directory / "memory.md").write_text(scenario.memory, encoding="utf-8")
    # Never read for auth (`_resources_for` is faked); its PRESENCE is what
    # lets `behavior_snapshot` sample instead of skipping "no api_key.txt".
    (directory / "api_key.txt").write_text("golden-fake-key\n", encoding="utf-8")
    # `read_news_digest` refreshes through the runner only when the script
    # exists, then reads the cache: both planted so the refresh is a journaled
    # call and the digest a fixed string.
    (agent_root / "scripts").mkdir()
    (agent_root / "scripts" / "news-fetch.sh").write_text("# golden: never run\n")
    (agent_root / "context").mkdir()
    (agent_root / "context" / "news_today.md").write_text("今日新闻：golden 摘要一条\n")
    if scenario.last_dream_hours_ago is not None:
        state = agent_root / ".agent-state"
        state.mkdir(parents=True, exist_ok=True)
        (state / f"last_dream_{_NAME}").write_text(
            str(_frozen_ts(hours_ago=scenario.last_dream_hours_ago)), encoding="utf-8"
        )
    if scenario.setup is not None:
        scenario.setup(agent_root)
    return directory


_RUN_ID = re.compile(r"\b[0-9a-f]{32}\b")
_LOCK_AGE = re.compile(r"held \(\d+s\)")
_LOG_STAMP = re.compile(r"^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] ", re.MULTILINE)


def _normaliser(agent_root: Path) -> Callable[[Any], Any]:
    roots = sorted({str(agent_root), str(agent_root.resolve())}, key=len, reverse=True)
    # Numbered by order of first appearance in the record (one normaliser per
    # record), so two places that must carry the SAME run id still read the
    # same placeholder, and a second, different id reads `<RUN_ID_2>`.
    run_ids: dict[str, str] = {}

    def run_id(match: re.Match[str]) -> str:
        return run_ids.setdefault(match.group(0), f"<RUN_ID_{len(run_ids) + 1}>")

    def text(value: str) -> str:
        for root in roots:
            value = value.replace(root, "<AGENT_ROOT>")
        value = _RUN_ID.sub(run_id, value)
        value = _LOCK_AGE.sub("held (<AGE>s)", value)
        return _LOG_STAMP.sub("[<TS>] ", value)

    def normalise(value: Any) -> Any:
        if isinstance(value, str):
            return text(value)
        if isinstance(value, list):
            return [normalise(v) for v in value]
        if isinstance(value, dict):
            return {
                k: ("<durationMs>" if k == "durationMs" else normalise(v)) for k, v in value.items()
            }
        return value

    return normalise


def _read(path: Path) -> str | None:
    return path.read_text(encoding="utf-8") if path.is_file() else None


def _lines(path: Path) -> list[str]:
    text = _read(path)
    return [] if text is None else text.splitlines()


def _run(
    scenario: Scenario,
    agent_root: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> dict[str, Any]:
    for variable in ("SWIL_REQUIRE_NON_PROD", "SWIL_ROUND_ID"):
        monkeypatch.delenv(variable, raising=False)
    directory = _build_roster(agent_root, scenario)

    journal: list[dict[str, Any]] = []
    resources = JournalingResources(journal)
    _seed_world(resources)
    backend = JournalingBackend(
        journal, *scenario.responses, unavailable=scenario.backend_unavailable
    )
    embedder = JournalingEmbedder(journal)
    guard = JournalingGuard(journal)
    job_runner = JournalingRunner(journal)

    def health_check(settings: Settings) -> bool:
        journal.append(_entry("platform", "health_check", (), {}))
        return scenario.online

    _patch_cycle_seams(
        monkeypatch,
        agent_root,
        settings=_settings(agent_root),
        resources=lambda persona, settings: resources,
        backend=lambda persona, settings: backend,
        embedder=lambda settings: embedder,
        guard=lambda settings: guard,
        health_check=health_check,
        runner=lambda settings: job_runner,
        clock=_FrozenClock,
    )

    result = runner.invoke(cli.app, list(scenario.argv))
    if result.exception is not None and not isinstance(result.exception, SystemExit):
        raise result.exception

    state = agent_root / ".agent-state"
    record = {
        "argv": list(scenario.argv),
        "exit_code": result.exit_code,
        "stdout": result.stdout.splitlines(),
        "stderr": result.stderr.splitlines(),
        "calls": journal,
        "auto_run_log": _lines(agent_root / "logs" / cli.ACT_LOG_FILENAME),
        "dream_log": _lines(agent_root / "logs" / cli.DREAM_LOG_FILENAME),
        "files": {
            name: _read(directory / name)
            for name in (
                "memory.md",
                "memory.archive.md",
                "personality.md",
                "personality.archive.md",
            )
        },
        "agent_state": {
            "dream_marker": _read(state / f"last_dream_{_NAME}"),
            "lock_files": sorted(p.name for p in state.glob("*lock_*")) if state.is_dir() else [],
        },
    }
    normalised: dict[str, Any] = _normaliser(agent_root)(_jsonable(record))
    return normalised


def _serialise(record: dict[str, Any]) -> str:
    return json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


@pytest.mark.parametrize("scenario", SCENARIOS, ids=[s.name for s in SCENARIOS])
def test_golden_run(
    scenario: Scenario,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    pinned_zone: None,
) -> None:
    # A real `swil-agent` process logs at INFO (`_main`'s `basicConfig`);
    # under pytest that `basicConfig` is a no-op and the root stays at
    # WARNING, which would drop every INFO line from both round logs.
    caplog.set_level(logging.INFO)
    actual = _serialise(_run(scenario, tmp_path, monkeypatch))
    path = GOLDEN_DIR / f"{scenario.name}.json"

    if os.environ.get(RECORD_ENV) == "1":
        GOLDEN_DIR.mkdir(exist_ok=True)
        path.write_text(actual, encoding="utf-8")
        return

    if not path.is_file():
        pytest.fail(f"{path.name} is missing -- record it with {RECORD_ENV}=1")
    expected = path.read_text(encoding="utf-8")
    if actual != expected:
        diff = "".join(
            difflib.unified_diff(
                expected.splitlines(keepends=True),
                actual.splitlines(keepends=True),
                fromfile=f"golden/{path.name}",
                tofile="actual",
            )
        )
        pytest.fail(f"{scenario.name} drifted from its golden file:\n{diff}", pytrace=False)


def test_every_scenario_has_a_golden_file_and_no_file_is_orphaned() -> None:
    """A renamed scenario must not leave its old golden behind as dead
    weight, and a new one must not pass by having no file to compare."""
    recorded = {path.stem for path in GOLDEN_DIR.glob("*.json")}
    assert recorded == {scenario.name for scenario in SCENARIOS}

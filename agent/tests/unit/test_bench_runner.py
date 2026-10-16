"""`bench/runner.py`: one persona x model run and the sweep, over fakes.

No real backend, embedder, server, clock or sleep: `BenchDeps` carries every
one of them (S3 §8, §12.18-§12.24).
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest

from swil_agent.api.client import ApiError
from swil_agent.api.resources import WriteNotVerifiedError
from swil_agent.bench.errors import BenchStop
from swil_agent.bench.judge import Judge
from swil_agent.bench.models import ModelUnderTest, resolve_model
from swil_agent.bench.persona import BenchPersona
from swil_agent.bench.runner import (
    BenchDeps,
    Task,
    check_batch_id,
    load_battery,
    parse_task_ids,
    run_batch_id,
    run_pair,
    run_sweep,
    select_tasks,
    sweep_batch_id,
)
from swil_agent.config import Settings
from swil_agent.llm.errors import BackendBinaryMissingError
from swil_agent.llm.runner import CompletionRequest, RunResult
from tests.unit._runners import FakeEmbedder, RecordingRunner, SilentBackend, StubBackend

REAL_BATTERY = Path(__file__).resolve().parents[2] / "bench" / "battery" / "tasks.json"

_PERSONA = (
    "---\nusername: aa\ndisplay_name: 阿甲\nmodel: claude:claude-opus-5-5\n"
    "board: making\nera: 3\n---\n# 阿甲\n\n不用感叹号的人。\n\n## 最近\n- 一条\n"
)
_TASKS = [Task("free_post", "post", "发一条。"), Task("comment_x", "comment", "评论一条。")]
_NOW = datetime(2026, 10, 14, 9, 3, 3, tzinfo=UTC)


class FakeSink:
    """`record_benchmark_run`, scripted: each entry is an id to return or an
    exception to raise; past the script every call files `run-<n>`."""

    def __init__(self, *script: str | Exception) -> None:
        self._script = list(script)
        self.bodies: list[dict[str, Any]] = []

    def record_benchmark_run(self, body: dict[str, Any]) -> str:
        self.bodies.append(dict(body))
        outcome = self._script.pop(0) if self._script else f"run-{len(self.bodies)}-abcdefgh"
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class Ticker:
    """A monotonic clock that advances `step` seconds per read."""

    def __init__(self, step: float = 1.2345) -> None:
        self.now = 100.0
        self.step = step

    def __call__(self) -> float:
        value = self.now
        self.now += self.step
        return value


def _persona_root(tmp_path: Path, name: str = "aa", raw: str = _PERSONA) -> Path:
    directory = tmp_path / "agents" / name
    directory.mkdir(parents=True)
    (directory / "personality.md").write_text(raw, encoding="utf-8")
    (directory / "api_key.txt").write_text("key\n", encoding="utf-8")
    return tmp_path


def _deps(
    root: Path,
    *,
    backend: Any = None,
    sink: FakeSink | None = None,
    embedder: Any = None,
    judge: Judge | None = None,
    out: list[str] | None = None,
    err: list[str] | None = None,
    sleeps: list[float] | None = None,
    sinks: dict[str, FakeSink] | None = None,
) -> BenchDeps:
    chosen = backend if backend is not None else StubBackend("  平静的一句 \n")
    the_sink = sink if sink is not None else FakeSink()

    def resolve(spec: str) -> ModelUnderTest:
        return ModelUnderTest(spec, chosen, None if spec == "codex" else spec)

    def sink_for(persona: BenchPersona) -> FakeSink:
        if sinks is not None:
            return sinks.setdefault(persona.name, FakeSink())
        return the_sink

    return BenchDeps(
        agent_root=root,
        resolve=resolve,
        embedder=embedder if embedder is not None else FakeEmbedder([[0.6, 0.8], [0.8, 0.6]]),
        sink_for=sink_for,
        judge=judge,
        now=lambda: _NOW,
        emit=(out if out is not None else []).append,
        emit_err=(err if err is not None else []).append,
        clock=Ticker(),
        sleep=(sleeps if sleeps is not None else []).append,
    )


# ── one run: the exact row ────────────────────────────────────────────────


def test_one_run_writes_and_posts_the_exact_bash_row(tmp_path: Path) -> None:
    root = _persona_root(tmp_path)
    sink = FakeSink("0123456789abcdef")
    out: list[str] = []
    batch = run_batch_id(_NOW)
    code = run_pair(
        _deps(root, sink=sink, out=out), _TASKS[:1], "aa", "sonnet", k=1, batch_id=batch
    )
    assert code == 0
    expected = {
        "batchId": "20261014T090303-1791968583000",
        "persona": "aa",
        "personaDisplay": "阿甲",
        "model": "sonnet",
        "taskId": "free_post",
        "taskKind": "post",
        "runIndex": 0,
        "output": "平静的一句",
        "vectorFidelity": 0.96,
        "judgeScore": None,
        "ruleScore": 1.0,
        "ruleDetail": "no_excl:ok",
        "latencyMs": 1234,
        "capturedAt": "2026-10-14T09:03:03Z",
    }
    path = root / "bench/results/aa/sonnet/20261014T090303-1791968583000__free_post__0.json"
    assert path.read_text(encoding="utf-8") == (
        json.dumps(expected, ensure_ascii=False, indent=2) + "\n"
    )
    assert list(json.loads(path.read_text(encoding="utf-8"))) == list(expected)
    assert sink.bodies == [expected]
    assert out == [
        "=== Persona Bench: @aa × sonnet × k=1  (1 tasks)  batch=" + batch + " ===",
        "  [free_post#0] fid=0.96 rule=1.0 judge=null 1234ms  post=01234567",
        "=== done @aa × sonnet (batch=" + batch + ") ===",
    ]


def test_the_model_gets_the_stripped_persona_and_the_task_prompt(tmp_path: Path) -> None:
    root = _persona_root(tmp_path)
    backend = StubBackend("x")
    run_pair(_deps(root, backend=backend), _TASKS, "aa", "opus", k=2, batch_id="b")
    assert [req.user for req in backend.calls] == ["发一条。"] * 2 + ["评论一条。"] * 2
    first: CompletionRequest = backend.calls[0]
    assert first.model == "opus"
    assert first.system.startswith("# 阿甲") and "model:" not in first.system
    names = sorted(p.name for p in (root / "bench/results/aa/opus").iterdir())
    assert names == [
        "b__comment_x__0.json",
        "b__comment_x__1.json",
        "b__free_post__0.json",
        "b__free_post__1.json",
    ]


def test_fidelity_embeds_the_reference_then_each_output(tmp_path: Path) -> None:
    root = _persona_root(tmp_path)
    embedder = FakeEmbedder([[1.0, 0.0], [1 / 3, 0.0]])
    sink = FakeSink()
    run_pair(_deps(root, embedder=embedder, sink=sink), _TASKS[:1], "aa", "m", k=1, batch_id="b")
    assert embedder.embedded == [["# 阿甲\n\n不用感叹号的人。\n\n## 最近\n- 一条"], ["平静的一句"]]
    assert sink.bodies[0]["vectorFidelity"] == 0.333333


def test_a_dead_embedder_degrades_fidelity_to_null_and_says_so(tmp_path: Path) -> None:
    root = _persona_root(tmp_path)
    embedder = FakeEmbedder(fail_always=True)
    sink = FakeSink()
    err: list[str] = []
    code = run_pair(
        _deps(root, embedder=embedder, sink=sink, err=err), _TASKS, "aa", "m", k=1, batch_id="b"
    )
    assert code == 0
    assert [body["vectorFidelity"] for body in sink.bodies] == [None, None]
    # Only the reference is tried: no output embed without one.
    assert embedder.call_count == 1
    assert err == ["bench: embedder unreachable — vectorFidelity will be null"]


def test_a_failed_output_embed_is_null_for_that_row_only(tmp_path: Path) -> None:
    root = _persona_root(tmp_path)
    embedder = FakeEmbedder([[1.0], [1.0], [0.5]], fail_on_call=2)
    sink = FakeSink()
    run_pair(_deps(root, embedder=embedder, sink=sink), _TASKS, "aa", "m", k=1, batch_id="b")
    assert [body["vectorFidelity"] for body in sink.bodies] == [None, 0.5]


def test_an_empty_answer_is_skipped_not_scored_not_posted(tmp_path: Path) -> None:
    root = _persona_root(tmp_path)
    sink = FakeSink()
    out: list[str] = []
    for backend in (StubBackend(" \n\t\n"), SilentBackend()):
        out.clear()
        code = run_pair(
            _deps(root, backend=backend, sink=sink, out=out),
            _TASKS[:1],
            "aa",
            "m",
            k=1,
            batch_id="b",
        )
        assert code == 0
        assert out[1] == "  [free_post#0] EMPTY (m) — skipped"
    assert sink.bodies == []
    assert list((root / "bench/results/aa/m").iterdir()) == []


def test_a_backend_that_cannot_run_stops_with_75(tmp_path: Path) -> None:
    class Missing:
        name = "missing"

        def complete(self, req: CompletionRequest) -> str:
            raise BackendBinaryMissingError("executable not found on PATH: 'codex'")

    root = _persona_root(tmp_path)
    with pytest.raises(BenchStop) as stop:
        run_pair(_deps(root, backend=Missing()), _TASKS, "aa", "codex", k=1, batch_id="b")
    assert stop.value.code == 75
    assert "not found on PATH" in stop.value.message


def test_rule_score_null_and_the_judge_score_land_in_the_row(tmp_path: Path) -> None:
    root = _persona_root(tmp_path, raw=_PERSONA.replace("不用感叹号的人", "安静的人"))
    runner = RecordingRunner("评分 88")
    sink = FakeSink()
    out: list[str] = []
    run_pair(
        _deps(root, sink=sink, judge=Judge(runner, "opus"), out=out),
        _TASKS[:1],
        "aa",
        "m",
        k=1,
        batch_id="b",
    )
    body = sink.bodies[0]
    assert (body["ruleScore"], body["ruleDetail"], body["judgeScore"]) == (None, "", 88)
    assert "rule=null judge=88" in out[1]
    # The judge reads the REFERENCE text and the cleaned output.
    assert runner.calls[0].stdin is not None
    assert runner.calls[0].stdin.endswith("## 最近\n- 一条\n\n===产出内容===\n平静的一句")


def test_captured_at_is_utc_whatever_the_clock_zone(tmp_path: Path) -> None:
    root = _persona_root(tmp_path)
    sink = FakeSink()
    deps = _deps(root, sink=sink)
    deps.now = lambda: datetime(2026, 10, 14, 17, 3, 3, tzinfo=timezone(timedelta(hours=8)))
    run_pair(deps, _TASKS[:1], "aa", "m", k=1, batch_id="b")
    assert sink.bodies[0]["capturedAt"] == "2026-10-14T09:03:03Z"


def test_the_archive_is_on_disk_before_the_post(tmp_path: Path) -> None:
    """The archive is the source of truth: written BEFORE the POST, so a POST
    that dies (or a process killed mid-POST) still leaves the row."""
    root = _persona_root(tmp_path)
    seen: list[dict[str, Any]] = []

    class ArchiveCheckingSink(FakeSink):
        def record_benchmark_run(self, body: dict[str, Any]) -> str:
            name = f"{body['batchId']}__{body['taskId']}__{body['runIndex']}.json"
            path = root / "bench/results/aa/m" / name
            seen.append(json.loads(path.read_text(encoding="utf-8")))
            assert seen[-1] == body
            return super().record_benchmark_run(body)

    run_pair(_deps(root, sink=ArchiveCheckingSink()), _TASKS, "aa", "m", k=2, batch_id="b")
    assert len(seen) == 4


def test_a_timed_out_model_call_is_reported_as_timeout_and_skipped(tmp_path: Path) -> None:
    """The model under test runs under the bench timeout (1200 s default, not
    the round's 300 s), and a call that still times out says TIMEOUT."""
    root = _persona_root(tmp_path)
    runner = RecordingRunner("ignored", timed_out=True)
    sink = FakeSink()
    out: list[str] = []
    deps = _deps(root, sink=sink, out=out)
    deps.resolve = lambda spec: resolve_model(spec, runner, Settings())
    code = run_pair(deps, _TASKS[:1], "aa", "sonnet", k=2, batch_id="b")
    assert code == 0
    assert out[1:3] == [
        "  [free_post#0] TIMEOUT (sonnet, 1200s) — skipped",
        "  [free_post#1] TIMEOUT (sonnet, 1200s) — skipped",
    ]
    assert sink.bodies == []
    assert [call.timeout for call in runner.calls] == [1200.0, 1200.0]


def test_the_timeout_flag_resets_per_call(tmp_path: Path) -> None:
    """One timed-out call does not mark the next one: a fresh answer files."""

    class OnceSlow(RecordingRunner):
        def run_result(self, argv, stdin=None, env=None, timeout=300.0, cwd=None):  # type: ignore[no-untyped-def]
            result = super().run_result(argv, stdin, env, timeout, cwd)
            if len(self.calls) == 1:
                return RunResult(stdout="", returncode=None, timed_out=True)
            return result

    root = _persona_root(tmp_path)
    runner = OnceSlow("答")
    sink = FakeSink()
    out: list[str] = []
    deps = _deps(root, sink=sink, out=out)
    deps.resolve = lambda spec: resolve_model(spec, runner, Settings(), timeout=7.0)
    run_pair(deps, _TASKS[:1], "aa", "opus", k=2, batch_id="b")
    assert out[1] == "  [free_post#0] TIMEOUT (opus, 7s) — skipped"
    assert [body["runIndex"] for body in sink.bodies] == [1]
    assert {call.timeout for call in runner.calls} == {7.0}


def test_a_model_call_that_exited_non_zero_is_failed_and_never_scored(tmp_path: Path) -> None:
    """S6 AG-F14: the judge already refuses a non-zero exit's stdout; the
    model under test did not, and filed a CLI's error text as the persona's
    answer, embedded and rule-scored."""
    root = _persona_root(tmp_path)
    runner = RecordingRunner("5-hour limit reached, resets at 3pm", returncode=1)
    sink = FakeSink()
    out: list[str] = []
    deps = _deps(root, sink=sink, out=out)
    deps.resolve = lambda spec: resolve_model(spec, runner, Settings())
    code = run_pair(deps, _TASKS[:1], "aa", "sonnet", k=2, batch_id="b")
    assert code == 0
    assert out[1:3] == [
        "  [free_post#0] FAILED (sonnet, exit 1) — skipped",
        "  [free_post#1] FAILED (sonnet, exit 1) — skipped",
    ]
    assert sink.bodies == []
    assert not list((root / "bench/results/aa/sonnet").glob("*.json"))


def test_the_failed_flag_resets_per_call(tmp_path: Path) -> None:
    class OnceFailing(RecordingRunner):
        def run_result(self, argv, stdin=None, env=None, timeout=300.0, cwd=None):  # type: ignore[no-untyped-def]
            result = super().run_result(argv, stdin, env, timeout, cwd)
            if len(self.calls) == 1:
                return RunResult(stdout="rate limited", returncode=2)
            return result

    root = _persona_root(tmp_path)
    runner = OnceFailing("答")
    sink = FakeSink()
    out: list[str] = []
    deps = _deps(root, sink=sink, out=out)
    deps.resolve = lambda spec: resolve_model(spec, runner, Settings())
    run_pair(deps, _TASKS[:1], "aa", "opus", k=2, batch_id="b")
    assert out[1] == "  [free_post#0] FAILED (opus, exit 2) — skipped"
    assert [body["runIndex"] for body in sink.bodies] == [1]


# ── POST failures and the throttle ────────────────────────────────────────


def test_a_failed_post_prints_err_keeps_the_file_goes_on_and_exits_75(tmp_path: Path) -> None:
    root = _persona_root(tmp_path)
    sink = FakeSink(ApiError(400, '{"error":{}}', None), WriteNotVerifiedError("no id"))
    out: list[str] = []
    err: list[str] = []
    code = run_pair(_deps(root, sink=sink, out=out, err=err), _TASKS, "aa", "m", k=2, batch_id="b")
    assert code == 75
    assert len(sink.bodies) == 4
    assert [line.rsplit("post=", 1)[1] for line in out[1:5]] == [
        "ERR",
        "ERR",
        "run-3-ab",
        "run-4-ab",
    ]
    assert len(list((root / "bench/results/aa/m").iterdir())) == 4
    assert err and "2 POST(s) failed" in err[-1]


def test_a_429_waits_retry_after_and_retries(tmp_path: Path) -> None:
    root = _persona_root(tmp_path)
    sink = FakeSink(ApiError(429, "slow", None, headers={"Retry-After": "7"}), "id-after-wait")
    sleeps: list[float] = []
    code = run_pair(_deps(root, sink=sink, sleeps=sleeps), _TASKS[:1], "aa", "m", k=1, batch_id="b")
    assert code == 0
    assert sleeps == [7.0]
    assert len(sink.bodies) == 2


def test_a_429_without_a_header_waits_a_minute_and_gives_up_after_three_retries(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    root = _persona_root(tmp_path)
    limited = [ApiError(429, "slow", None) for _ in range(4)]
    sink = FakeSink(*limited)
    sleeps: list[float] = []
    with caplog.at_level(logging.WARNING, logger="swil_agent.bench.runner"):
        code = run_pair(
            _deps(root, sink=sink, sleeps=sleeps), _TASKS[:1], "aa", "m", k=1, batch_id="b"
        )
    assert code == 75
    assert sleeps == [60.0, 60.0, 60.0]
    assert len(sink.bodies) == 4
    assert "POST failed" in caplog.text


def test_the_throttle_holds_posts_to_18_a_minute(tmp_path: Path) -> None:
    root = _persona_root(tmp_path)
    sleeps: list[float] = []
    deps = _deps(root, sleeps=sleeps)
    deps.throttle._clock = lambda: 0.0  # every POST in the same instant
    tasks = [Task(f"t{i}", "post", "p") for i in range(19)]
    run_pair(deps, tasks, "aa", "m", k=1, batch_id="b")
    assert sleeps == [60.0]


# ── tasks and batch ids ───────────────────────────────────────────────────


def test_the_real_battery_loads_in_file_order() -> None:
    battery = load_battery(REAL_BATTERY)
    assert [task.id for task in battery][:3] == ["free_post", "self_intro", "daily_dusk"]
    assert len(battery) == 10
    assert all(task.prompt and task.kind for task in battery)


def test_task_ids_split_like_bash_and_keep_the_given_order() -> None:
    assert parse_task_ids(None) is None
    assert parse_task_ids("comment_x, free_post") == ["comment_x", "free_post"]
    assert parse_task_ids("free _post") == ["free_post"]
    picked = select_tasks(_TASKS, ["comment_x", "free_post"])
    assert [task.id for task in picked] == ["comment_x", "free_post"]
    assert select_tasks(_TASKS, None) == _TASKS


@pytest.mark.parametrize("raw", ["", " ", ",", " , ,"])
def test_a_set_but_empty_task_selection_is_refused_with_64(raw: str) -> None:
    """Bash ran nothing for it; silently running the whole battery would err
    in the expensive direction. Unset (`None`) is still the whole battery."""
    with pytest.raises(BenchStop) as stop:
        parse_task_ids(raw)
    assert stop.value.code == 64
    assert "names no task" in stop.value.message


def test_an_unknown_task_id_is_refused_with_64() -> None:
    with pytest.raises(BenchStop) as stop:
        select_tasks(_TASKS, ["free_post", "nope"])
    assert stop.value.code == 64
    assert "nope" in stop.value.message


def test_batch_id_formats_match_the_existing_result_files() -> None:
    assert run_batch_id(_NOW) == "20261014T090303-1791968583000"
    assert sweep_batch_id(_NOW) == "20261014T090303-sweep"
    local = _NOW.astimezone(timezone(timedelta(hours=-7)))
    assert sweep_batch_id(local) == "20261014T090303-sweep"
    check_batch_id("x" * 80)
    for bad in ("", " ", "x" * 81, "a/b"):
        with pytest.raises(BenchStop) as stop:
            check_batch_id(bad)
        assert stop.value.code == 64


# ── the sweep ─────────────────────────────────────────────────────────────


def test_the_sweep_shares_one_batch_id_and_uses_codex_k_for_codex(tmp_path: Path) -> None:
    root = _persona_root(tmp_path, "aa")
    _persona_root(root, "bb", _PERSONA.replace("username: aa", "username: bb"))
    sinks: dict[str, FakeSink] = {}
    out: list[str] = []
    code = run_sweep(
        _deps(root, out=out, sinks=sinks),
        _TASKS[:1],
        ["aa", "bb"],
        ["codex", "sonnet", "codex:gpt-5.6-luna"],
        k=3,
        codex_k=1,
        batch_id="20261014T090303-sweep",
        tasks_label=None,
    )
    assert code == 0
    for name in ("aa", "bb"):
        models = [body["model"] for body in sinks[name].bodies]
        assert models == ["codex", "sonnet", "sonnet", "sonnet", "codex:gpt-5.6-luna"]
        assert {body["batchId"] for body in sinks[name].bodies} == {"20261014T090303-sweep"}
    assert (root / "bench/results/aa/codex_gpt-5.6-luna").is_dir()
    assert out[:5] == [
        "############ Persona Bench sweep  batch=20261014T090303-sweep ############",
        "personas: aa bb",
        "models:   codex sonnet codex:gpt-5.6-luna",
        "tasks:    <full battery>   K=3 (codex K=1)",
        "",
    ]
    assert out[-3:] == [
        "",
        "############ sweep complete: batch=20261014T090303-sweep ############",
        "view: /lab?view=benchmark",
    ]


def test_the_sweep_goes_on_past_a_failing_pair_and_returns_the_worst_code(
    tmp_path: Path,
) -> None:
    root = _persona_root(tmp_path, "aa")
    sinks: dict[str, FakeSink] = {"aa": FakeSink(ApiError(500, "boom", None))}
    err: list[str] = []
    code = run_sweep(
        _deps(root, err=err, sinks=sinks),
        _TASKS[:1],
        ["ghost", "aa"],
        ["sonnet", "opus"],
        k=1,
        codex_k=1,
        batch_id="s",
        tasks_label="free_post",
    )
    assert code == 75
    assert err[:2] == ["bench: persona 'ghost' not found"] * 2
    assert [body["model"] for body in sinks["aa"].bodies] == ["sonnet", "opus"]


def test_a_sweep_of_only_missing_personas_returns_66(tmp_path: Path) -> None:
    out: list[str] = []
    code = run_sweep(
        _deps(tmp_path, out=out),
        _TASKS,
        ["ghost"],
        ["sonnet"],
        k=1,
        codex_k=1,
        batch_id="s",
        tasks_label="free_post,comment_x",
    )
    assert code == 66
    assert out[3] == "tasks:    free_post,comment_x   K=1 (codex K=1)"

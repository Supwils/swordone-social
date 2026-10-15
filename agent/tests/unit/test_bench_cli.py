"""`swil-agent bench run|all` through `CliRunner`, every seam faked.

`compose.load_settings`, `health_check`, `embedder_for`, `runner_for`,
`resources_for_key` and `now` are replaced, so nothing here can reach a
server, an embedder or an LLM CLI (S3 §8, §12.21, §12.22, Review Focus 4).
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, tzinfo
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from swil_agent import cli
from swil_agent.bench.judge import SCRUBBED_ENV, judge_argv
from swil_agent.cli import compose
from swil_agent.cli.errors import AccountSetupError
from swil_agent.config import Settings
from swil_agent.embedder.client import EmbedderUnavailable
from swil_agent.llm.runner import RunResult
from tests.unit._runners import RunnerCall

runner = CliRunner()

_NOW = datetime(2026, 10, 14, 9, 3, 3, tzinfo=UTC)
_BATTERY = {
    "version": 1,
    "tasks": [
        {"id": "free_post", "kind": "post", "title": "t", "prompt": "发一条。"},
        {"id": "comment_x", "kind": "comment", "title": "t", "prompt": "评论一条。"},
    ],
}
_PERSONA = (
    "---\nusername: {name}\ndisplay_name: 阿甲\nmodel: claude:claude-opus-5-5\n"
    "board: making\nera: 3\n---\n# 阿甲\n\n一段人设。\n\n## 最近\n- 一条\n"
)


class BenchRunner:
    """Answers like each CLI would: the judge (no `--system-prompt`) with a
    score, codex through its `-o` file, everything else with text."""

    def __init__(self, judge_answer: str = "80") -> None:
        self.judge_answer = judge_answer
        self.model_times_out = False
        self.calls: list[RunnerCall] = []

    def run_result(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = 300.0,
    ) -> RunResult:
        stdout = self.run(argv, stdin, env, timeout)
        if self.model_times_out and "--system-prompt" in argv:
            return RunResult(stdout="", returncode=None, timed_out=True)
        return RunResult(stdout=stdout, returncode=0)

    def run(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = 300.0,
    ) -> str:
        self.calls.append(RunnerCall(argv=list(argv), stdin=stdin, env=env, timeout=timeout))
        if argv[0] == "codex":
            Path(argv[argv.index("-o") + 1]).write_text("codex 的回答", encoding="utf-8")
            return ""
        if "--system-prompt" not in argv:
            return self.judge_answer
        return "回答"

    def judge_calls(self) -> list[RunnerCall]:
        return [call for call in self.calls if "--system-prompt" not in call.argv]

    def model_calls(self) -> list[RunnerCall]:
        return [call for call in self.calls if call not in self.judge_calls()]


class FakeEmbedder:
    def __init__(self, *, healthy: bool = True) -> None:
        self.healthy = healthy

    def health(self) -> dict[str, Any]:
        if not self.healthy:
            raise EmbedderUnavailable("health check failed: refused")
        return {"ok": True}

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [[1.0, 0.0] for _ in texts]


class FakeSink:
    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.bodies: list[dict[str, Any]] = []

    def record_benchmark_run(self, body: dict[str, Any]) -> str:
        self.bodies.append(body)
        if self.fail:
            from swil_agent.api.client import ApiError

            raise ApiError(400, "bad", None)
        return f"id-{len(self.bodies)}-xxxxxxxx"


class Seams:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.runner = BenchRunner()
        self.embedder = FakeEmbedder()
        self.server_up = True
        self.sinks: dict[str, FakeSink] = {}
        self.fail_posts = False
        self.health_calls = 0


@pytest.fixture
def seams(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Seams:
    (tmp_path / "bench" / "battery").mkdir(parents=True)
    (tmp_path / "bench" / "battery" / "tasks.json").write_text(
        json.dumps(_BATTERY, ensure_ascii=False), encoding="utf-8"
    )
    for name in ("aa", "bb"):
        directory = tmp_path / "agents" / name
        directory.mkdir(parents=True)
        (directory / "personality.md").write_text(_PERSONA.format(name=name), encoding="utf-8")
        (directory / "api_key.txt").write_text("key\n", encoding="utf-8")
    state = Seams(tmp_path)
    settings = Settings(
        swil_url="http://127.0.0.1:9", embedder_url="http://127.0.0.1:9", agent_root=tmp_path
    )

    def health_check(_settings: Settings) -> bool:
        state.health_calls += 1
        return state.server_up

    def resources_for_key(directory: Path, _settings: Settings) -> FakeSink:
        return state.sinks.setdefault(directory.name, FakeSink(state.fail_posts))

    def now(tz: tzinfo | None = None) -> datetime:
        return _NOW

    monkeypatch.setattr(compose, "load_settings", lambda: settings)
    monkeypatch.setattr(compose, "health_check", health_check)
    monkeypatch.setattr(compose, "embedder_for", lambda _settings: state.embedder)
    monkeypatch.setattr(compose, "runner_for", lambda _settings: state.runner)
    monkeypatch.setattr(compose, "resources_for_key", resources_for_key)
    monkeypatch.setattr(compose, "now", now)
    for var in (
        "JUDGE",
        "JUDGE_MODEL",
        "BENCH_TASKS",
        "BENCH_TIMEOUT",
        "PERSONAS",
        "MODELS",
        "K",
        "CODEX_K",
    ):
        monkeypatch.delenv(var, raising=False)
    return state


def _invoke(*args: str, env: dict[str, str] | None = None) -> Any:
    return runner.invoke(cli.app, ["bench", *args], env=env)


# ── run ───────────────────────────────────────────────────────────────────


def test_run_files_every_task_under_the_default_batch_id(seams: Seams) -> None:
    result = _invoke("run", "aa", "sonnet", "--k", "2")
    assert result.exit_code == 0, result.output
    batch = "20261014T090303-1791968583000"
    files = sorted(p.name for p in (seams.root / "bench/results/aa/sonnet").iterdir())
    assert files == [f"{batch}__{t}__{i}.json" for t in ("comment_x", "free_post") for i in (0, 1)]
    bodies = seams.sinks["aa"].bodies
    assert [(b["taskId"], b["runIndex"]) for b in bodies] == [
        ("free_post", 0),
        ("free_post", 1),
        ("comment_x", 0),
        ("comment_x", 1),
    ]
    assert {b["batchId"] for b in bodies} == {batch}
    assert all(b["judgeScore"] is None for b in bodies)
    assert seams.runner.judge_calls() == []
    assert f"=== Persona Bench: @aa × sonnet × k=2  (2 tasks)  batch={batch} ===" in result.stdout


def test_run_flags_default_from_the_bash_env_vars(seams: Seams) -> None:
    result = _invoke(
        "run",
        "aa",
        "haiku",
        "--batch-id",
        "manual",
        env={"BENCH_TASKS": "comment_x", "JUDGE": "1", "JUDGE_MODEL": "opus"},
    )
    assert result.exit_code == 0, result.output
    bodies = seams.sinks["aa"].bodies
    assert [(b["taskId"], b["judgeScore"], b["batchId"]) for b in bodies] == [
        ("comment_x", 80, "manual")
    ] * 3
    assert [call.argv for call in seams.runner.judge_calls()] == [judge_argv("opus")] * 3


def test_judge_zero_from_the_env_is_off(seams: Seams) -> None:
    result = _invoke("run", "aa", "sonnet", "--k", "1", env={"JUDGE": "0"})
    assert result.exit_code == 0, result.output
    assert seams.runner.judge_calls() == []


def test_a_deepseek_configured_shell_never_reaches_the_judge(
    seams: Seams, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """S3 Review Focus 4: the caller's shell exports DeepSeek's endpoint; the
    judge's env strips all four variables, the `ds-flash` call sets its own."""
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    (home / ".claude" / ".deepseek-key").write_text("sk-file\n", encoding="utf-8")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://shell.example/anthropic")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "sk-shell")
    monkeypatch.setenv("ANTHROPIC_MODEL", "deepseek-v4-flash")
    result = _invoke("run", "aa", "ds-flash", "--k", "1", "--tasks", "free_post", "--judge")
    assert result.exit_code == 0, result.output
    (judge,) = seams.runner.judge_calls()
    assert judge.argv == judge_argv("sonnet")
    assert judge.env == dict.fromkeys(SCRUBBED_ENV, "")
    (model,) = seams.runner.model_calls()
    assert model.env is not None
    # The backend's own values from the key file, not the shell's.
    assert model.env["ANTHROPIC_BASE_URL"] == "https://api.deepseek.com/anthropic"
    assert model.env["ANTHROPIC_AUTH_TOKEN"] == "sk-file"
    assert model.argv[model.argv.index("--model") + 1] == "deepseek-v4-flash"
    assert (seams.root / "bench/results/aa/ds-flash").is_dir()


def test_the_roster_form_files_under_an_underscored_directory(seams: Seams) -> None:
    result = _invoke("run", "aa", "codex:gpt-5.6-luna", "--k", "1", "--tasks", "free_post")
    assert result.exit_code == 0, result.output
    assert seams.sinks["aa"].bodies[0]["model"] == "codex:gpt-5.6-luna"
    assert seams.sinks["aa"].bodies[0]["output"] == "codex 的回答"
    assert (seams.root / "bench/results/aa/codex_gpt-5.6-luna").is_dir()


def test_the_model_under_test_gets_the_bench_timeout(seams: Seams) -> None:
    """1200 s by default, `--timeout` / `BENCH_TIMEOUT` to change it; the
    judge keeps the round's 300 s."""
    assert _invoke("run", "aa", "sonnet", "--k", "1", "--judge").exit_code == 0
    assert {c.timeout for c in seams.runner.model_calls()} == {1200.0}
    assert {c.timeout for c in seams.runner.judge_calls()} == {300.0}
    seams.runner.calls.clear()
    assert _invoke("run", "aa", "sonnet", "--k", "1", "--timeout", "90").exit_code == 0
    assert {c.timeout for c in seams.runner.model_calls()} == {90.0}
    seams.runner.calls.clear()
    result = _invoke("all", "--personas", "aa", "--models", "opus", env={"BENCH_TIMEOUT": "45"})
    assert result.exit_code == 0, result.output
    assert {c.timeout for c in seams.runner.model_calls()} == {45.0}


def test_a_timed_out_model_call_prints_timeout_not_empty(seams: Seams) -> None:
    seams.runner.model_times_out = True
    result = _invoke("run", "aa", "sonnet", "--k", "1", "--tasks", "free_post")
    assert result.exit_code == 0, result.output
    assert "  [free_post#0] TIMEOUT (sonnet, 1200s) — skipped" in result.stdout
    assert "EMPTY" not in result.stdout
    assert "aa" not in seams.sinks or seams.sinks["aa"].bodies == []


def test_an_explicitly_empty_task_selection_is_64(seams: Seams) -> None:
    assert _invoke("run", "aa", "sonnet", "--tasks", "").exit_code == 64
    assert _invoke("run", "aa", "sonnet", env={"BENCH_TASKS": ","}).exit_code == 64
    assert _invoke("all", "--tasks", " ").exit_code == 64
    assert seams.runner.calls == []
    # An EMPTY env var is unset (Click, and Bash's `[[ -n ]]`): the whole battery.
    result = _invoke("run", "aa", "sonnet", "--k", "1", env={"BENCH_TASKS": ""})
    assert result.exit_code == 0, result.output
    assert "(2 tasks)" in result.stdout


def test_a_persona_name_the_server_refuses_is_64_before_any_path(seams: Seams) -> None:
    for bad in ("../aa", "a", "x" * 25, "a-b"):
        result = _invoke("run", bad, "sonnet")
        assert result.exit_code == 64, bad
        assert "not a valid name" in result.output
    assert _invoke("all", "--personas", "aa ../bb").exit_code == 64
    assert seams.health_calls == 0
    assert seams.runner.calls == []


def test_an_unknown_task_is_64_before_anything_runs(seams: Seams) -> None:
    result = _invoke("run", "aa", "sonnet", "--tasks", "free_post,nope")
    assert result.exit_code == 64
    assert "unknown task id(s) nope" in result.output
    assert seams.health_calls == 0
    assert seams.runner.calls == []


def test_a_bad_model_or_batch_id_is_64(seams: Seams) -> None:
    assert _invoke("run", "aa", "gork:x").exit_code == 64
    assert _invoke("run", "aa", "sonnet", "--batch-id", "x" * 81).exit_code == 64
    assert seams.runner.calls == []


def test_k_outside_what_the_server_accepts_is_a_usage_error(seams: Seams) -> None:
    assert _invoke("run", "aa", "sonnet", "--k", "0").exit_code == 2
    assert _invoke("run", "aa", "sonnet", "--k", "66").exit_code == 2


def test_a_missing_persona_is_66(seams: Seams) -> None:
    result = _invoke("run", "ghost", "sonnet")
    assert result.exit_code == 66
    assert "persona 'ghost' not found" in result.output


def test_a_server_down_is_75_with_the_remedy(seams: Seams) -> None:
    seams.server_up = False
    result = _invoke("run", "aa", "sonnet")
    assert result.exit_code == 75
    assert "server unreachable at http://127.0.0.1:9/health" in result.output
    assert seams.runner.calls == []


def test_an_embedder_down_is_75_with_the_remedy(seams: Seams) -> None:
    seams.embedder = FakeEmbedder(healthy=False)
    result = _invoke("run", "aa", "sonnet")
    assert result.exit_code == 75
    assert "embedder unreachable at http://127.0.0.1:9" in result.output
    assert "embedder/start.sh" in result.output
    assert seams.runner.calls == []


def test_a_failed_post_is_75_and_the_rows_stay_on_disk(seams: Seams) -> None:
    seams.fail_posts = True
    result = _invoke("run", "aa", "sonnet", "--k", "1")
    assert result.exit_code == 75
    assert result.stdout.count("post=ERR") == 2
    assert len(list((seams.root / "bench/results/aa/sonnet").iterdir())) == 2


def test_an_unusable_key_is_75(seams: Seams, monkeypatch: pytest.MonkeyPatch) -> None:
    def no_key(directory: Path, _settings: Settings) -> FakeSink:
        raise AccountSetupError("aa: no usable api_key.txt (blank)")

    monkeypatch.setattr(compose, "resources_for_key", no_key)
    result = _invoke("run", "aa", "sonnet")
    assert result.exit_code == 75
    assert "no usable api_key.txt" in result.output


# ── all ───────────────────────────────────────────────────────────────────


def test_all_shares_one_sweep_batch_id_and_reads_its_env_vars(seams: Seams) -> None:
    result = _invoke(
        "all",
        env={
            "PERSONAS": "aa bb",
            "MODELS": "codex sonnet",
            "K": "2",
            "CODEX_K": "1",
            "BENCH_TASKS": "free_post",
        },
    )
    assert result.exit_code == 0, result.output
    for name in ("aa", "bb"):
        bodies = seams.sinks[name].bodies
        assert [b["model"] for b in bodies] == ["codex", "sonnet", "sonnet"]
        assert {b["batchId"] for b in bodies} == {"20261014T090303-sweep"}
    assert "tasks:    free_post   K=2 (codex K=1)" in result.stdout
    assert "############ sweep complete: batch=20261014T090303-sweep ############" in result.stdout
    assert seams.health_calls == 1


def test_all_defaults_are_the_bash_defaults(seams: Seams) -> None:
    """Five personas this tree does not have: each pair reports 66 and the
    sweep goes on to the end."""
    result = _invoke("all", "--tasks", "free_post")
    assert result.exit_code == 66
    assert "personas: liushang shengyin chawendao mangniu zhuiyi" in result.stdout
    assert "models:   codex sonnet ds-flash" in result.stdout
    assert "K=3 (codex K=1)" in result.stdout
    assert result.output.count("not found") == 15


def test_all_refuses_a_bad_model_or_task_up_front(seams: Seams) -> None:
    assert _invoke("all", "--models", "sonnet a/b").exit_code == 64
    assert _invoke("all", "--tasks", "nope").exit_code == 64
    assert seams.health_calls == 0


def test_all_with_the_server_down_is_75(seams: Seams) -> None:
    seams.server_up = False
    result = _invoke("all", "--personas", "aa")
    assert result.exit_code == 75
    assert seams.runner.calls == []


def test_bench_with_no_command_prints_help(seams: Seams) -> None:
    result = _invoke()
    assert "run" in result.output and "all" in result.output

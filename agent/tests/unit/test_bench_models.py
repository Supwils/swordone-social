"""`bench/models.py`: what a `<model>` argument dispatches to (S3 §12.23).

The argv pins here are the exact `llm.sh` invocations the deleted
`benchmark-run.sh` reached through `llm_text`; the tool-less halves of them
are also pinned in `test_backends.py` beside every other backend's.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from swil_agent.bench.errors import BenchStop
from swil_agent.bench.models import (
    ModelUnderTest,
    check_model_spec,
    is_codex,
    model_dir_name,
    resolve_model,
)
from swil_agent.config import Settings
from swil_agent.llm.runner import CompletionRequest
from tests.unit._runners import RecordingRunner, assert_isolated_cwd

_REQ = CompletionRequest(system="SYS", user="USR")


def _settings(**overrides: object) -> Settings:
    return Settings(swil_url="http://127.0.0.1:9", **overrides)  # type: ignore[arg-type]


class CodexRunner(RecordingRunner):
    """Writes the answer where `codex exec -o` would."""

    def run(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = 300.0,
        cwd: str | None = None,
    ) -> str:
        super().run(argv, stdin, env, timeout, cwd)
        Path(argv[argv.index("-o") + 1]).write_text("answer", encoding="utf-8")
        return ""


def _call(model: ModelUnderTest) -> None:
    model.backend.complete(_REQ.model_copy(update={"model": model.model}))


def test_a_bare_word_is_a_claude_alias_with_the_bash_argv() -> None:
    """`llm_text claude "$MODEL" "$SYS" "$user"` -- every unknown bare word,
    `grok` included, as in Bash."""
    for spec in ("sonnet", "opus", "grok"):
        runner = RecordingRunner("x")
        model = resolve_model(spec, runner, _settings())
        assert (model.spec, model.model, model.dir_name) == (spec, spec, spec)
        _call(model)
        call = runner.calls[0]
        assert call.argv == [
            "claude",
            "-p",
            "--tools",
            "",
            "--strict-mcp-config",
            "--setting-sources",
            "",
            "--disable-slash-commands",
            "--no-session-persistence",
            "--effort",
            "high" if spec == "opus" else "xhigh",
            "--model",
            spec,
            "--system-prompt",
            "SYS",
            "--output-format",
            "text",
        ]
        assert (call.stdin, call.env) == ("USR", None)
        assert_isolated_cwd(call)


def test_codex_is_the_cli_default_model_read_only() -> None:
    runner = CodexRunner()
    model = resolve_model("codex", runner, _settings())
    assert model.model is None
    _call(model)
    argv = runner.calls[0].argv
    out = argv[argv.index("-o") + 1]
    cwd = runner.calls[0].cwd
    assert argv == [
        "codex",
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--ignore-rules",
        "-C",
        cwd,
        "-c",
        "model_reasoning_effort=high",
        "-c",
        "service_tier=priority",
        "--disable",
        "shell_tool",
        "--disable",
        "unified_exec",
        "--disable",
        "apps",
        "--disable",
        "plugins",
        "--disable",
        "hooks",
        "-c",
        "web_search=disabled",
        "-s",
        "read-only",
        "--color",
        "never",
        "-o",
        out,
        "System:\nSYS\n\n---\n\nUSR",
    ]
    assert_isolated_cwd(runner.calls[0])


def test_ds_flash_runs_deepseek_v4_flash_with_its_own_env() -> None:
    """S3 Review Focus 4, the model-under-test half: `ds-flash`'s subprocess
    carries the DeepSeek values (the judge's carries none of them)."""
    runner = RecordingRunner("x")
    model = resolve_model("ds-flash", runner, _settings(), deepseek_api_key="sk-test")
    assert (model.model, model.dir_name) == ("deepseek-v4-flash", "ds-flash")
    _call(model)
    call = runner.calls[0]
    assert call.argv == [
        "claude",
        "-p",
        "--tools",
        "",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--model",
        "deepseek-v4-flash",
        "--system-prompt",
        "SYS",
        "--output-format",
        "text",
    ]
    assert call.env == {
        "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
        "ANTHROPIC_AUTH_TOKEN": "sk-test",
        "ANTHROPIC_API_KEY": "",
        "ANTHROPIC_MODEL": "deepseek-v4-flash",
        "CLAUDE_CODE_EFFORT_LEVEL": "medium",
    }


def test_ds_flash_without_a_key_is_a_setup_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    with pytest.raises(BenchStop) as stop:
        resolve_model("ds-flash", RecordingRunner(), _settings())
    assert stop.value.code == 75
    assert "deepseek key not found" in stop.value.message


def test_the_roster_form_resolves_like_a_persona_model_line() -> None:
    runner = RecordingRunner("x")
    model = resolve_model("grok:grok-4.6", runner, _settings())
    assert (model.backend.name, model.model) == ("grok", "grok-4.6")
    assert model.dir_name == "grok_grok-4.6"
    _call(model)
    argv = runner.calls[0].argv
    assert argv[argv.index("-m") : argv.index("-m") + 2] == ["-m", "grok-4.6"]

    codex = CodexRunner()
    luna = resolve_model("codex:gpt-5.6-luna", codex, _settings())
    _call(luna)
    argv = codex.calls[0].argv
    assert argv[argv.index("-m") : argv.index("-m") + 2] == ["-m", "gpt-5.6-luna"]

    claude = resolve_model("claude:claude-opus-5-5", RecordingRunner(), _settings())
    assert (claude.backend.name, claude.model) == ("claude", "claude-opus-5-5")
    cursor = resolve_model("cursor:gemini-3.7-flash-high", RecordingRunner(), _settings())
    assert cursor.backend.name == "cursor"
    deepseek = resolve_model(
        "deepseek:deepseek-v4-pro", RecordingRunner(), _settings(), deepseek_api_key="k"
    )
    assert (deepseek.backend.name, deepseek.model) == ("deepseek", "deepseek-v4-pro")


def test_the_roster_form_is_never_overridden_by_the_environment() -> None:
    """`SWIL_LLM_BACKEND` / `SWIL_LLM_MODEL` are defaults for files that
    declare nothing; what the operator typed is a flag and outranks both."""
    settings = _settings(swil_llm_backend="codex", swil_llm_model="other")
    model = resolve_model("claude:haiku", RecordingRunner(), settings)
    assert (model.backend.name, model.model) == ("claude", "haiku")


def test_an_api_model_resolves_through_the_factory_and_needs_its_key() -> None:
    with pytest.raises(BenchStop) as stop:
        resolve_model("api:grok-4.6", RecordingRunner(), _settings(swil_llm_provider="xai"))
    assert stop.value.code == 75
    assert "SWIL_LLM_API_KEY" in stop.value.message
    keyed = _settings(swil_llm_provider="xai", swil_llm_api_key="sk-x")
    model = resolve_model("api:grok-4.6", RecordingRunner(), keyed)
    assert (model.backend.name, model.model, model.dir_name) == ("xai", "grok-4.6", "api_grok-4.6")


@pytest.mark.parametrize(
    "spec", ["", "  ", "x" * 41, "a/b", "..", "gork:grok-4.6", "claude:", "codex: "]
)
def test_a_model_the_server_or_the_path_cannot_take_is_refused_with_64(spec: str) -> None:
    with pytest.raises(BenchStop) as stop:
        check_model_spec(spec)
    assert stop.value.code == 64


def test_forty_characters_is_allowed() -> None:
    check_model_spec("m" * 40)


def test_codex_k_applies_to_every_codex_spelling() -> None:
    assert is_codex("codex")
    assert is_codex("codex:gpt-5.6-luna")
    assert is_codex("codex_cli:gpt-5.6-luna")
    assert not is_codex("sonnet")
    assert not is_codex("ds-flash")
    assert not is_codex("grok:grok-4.6")
    assert model_dir_name("a:b:c") == "a_b_c"

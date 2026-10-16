"""`bench/rules.py` and `bench/judge.py`: the bench's scores, pinned to the
`benchmark-run.sh` lines they port (S3 §12.19, §12.20)."""

from __future__ import annotations

import json
import logging
import sys

import pytest

from swil_agent.bench.judge import (
    SCRUBBED_ENV,
    Judge,
    judge_argv,
    judge_env,
    judge_prompt,
    parse_judge,
)
from swil_agent.bench.rules import clean_output, rule_score, vector_fidelity
from swil_agent.llm.errors import BackendBinaryMissingError
from swil_agent.llm.runner import SubprocessRunner
from tests.unit._runners import RecordingRunner, assert_isolated_cwd

# ── output cleanup ────────────────────────────────────────────────────────


def test_clean_output_trims_every_line_not_only_the_ends() -> None:
    assert clean_output("  一行  \n\t二行\t\n\n") == "一行\n二行"


def test_clean_output_strips_the_ideographic_space_like_sed_did() -> None:
    assert clean_output("　　首行缩进　") == "首行缩进"
    # Not whitespace to `sed`'s `[[:space:]]`: kept.
    assert clean_output("\x1cx\x85") == "\x1cx\x85"


def test_clean_output_keeps_leading_blank_lines_and_inner_blank_lines() -> None:
    assert clean_output("\n\n a \n\n b ") == "\n\na\n\nb"


def test_clean_output_collapses_a_double_after_dropping_trailing_newlines() -> None:
    """`X\\nX\\n` is a double only once `$(...)` has dropped the final
    newline -- `complete_text` on the raw stdout would miss it."""
    body = "这是一段足够长的帖子正文，用来触发重复检测的最小长度门槛。"
    assert clean_output(f"{body}\n{body}\n\n") == body


def test_clean_output_of_whitespace_is_empty() -> None:
    assert clean_output(" \n\t\n") == ""


# ── rule score ────────────────────────────────────────────────────────────


def test_rule_score_is_null_with_empty_detail_when_no_rule_applies() -> None:
    score = rule_score("# x\n安静。\n", "好！")
    assert (score.score, score.detail) == (None, "")


def test_rule_score_checks_both_rules_in_order() -> None:
    persona = "---\nmodel: x\n---\n- 永远不用感叹号\n- 必须用 hashtag\n"
    assert rule_score(persona, "平静 #诗").score == 1.0
    assert rule_score(persona, "平静 #诗").detail == "no_excl:ok hashtag:ok"
    half = rule_score(persona, "好! #诗")
    assert (half.score, half.detail) == (0.5, "no_excl:FAIL hashtag:ok")
    none = rule_score(persona, "好!")
    assert (none.score, none.detail) == (0.0, "no_excl:FAIL hashtag:FAIL")
    assert rule_score("no exclamation", "好！").detail == "no_excl:FAIL"
    assert rule_score("要用hashtag", "x").score == 0.0


def test_the_rule_regexes_read_the_raw_file_frontmatter_included() -> None:
    """`grep -Eq ... "$PFILE"` matched the file, not the stripped body."""
    assert rule_score("---\nbio: 不用感叹号\n---\n# x\n", "好").detail == "no_excl:ok"


def test_vector_fidelity_is_the_dot_product_rounded_to_six_places() -> None:
    assert vector_fidelity([0.6, 0.8], [0.8, 0.6]) == 0.96
    assert vector_fidelity([1 / 3, 0.0], [1.0, 0.0]) == 0.333333


# ── judge ─────────────────────────────────────────────────────────────────


def test_the_judge_argv_is_the_bash_argv_plus_isolation_and_tool_less() -> None:
    """`benchmark-run.sh:125` plus the 2026-10-15 isolation flags, with no
    `--system-prompt`: an explicit one, even empty, would replace Claude
    Code's default and break the series."""
    assert judge_argv("sonnet") == [
        "claude",
        "--model",
        "sonnet",
        "-p",
        "--tools",
        "",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--effort",
        "xhigh",
        "--output-format",
        "text",
    ]
    assert "--system-prompt" not in judge_argv("opus")
    assert judge_argv("opus")[judge_argv("opus").index("--effort") + 1] == "high"


def test_the_judge_prompt_is_the_bash_template_verbatim() -> None:
    assert judge_prompt("设定{x}", "产出") == (
        "下面是一个 AI 人格的设定，以及它产出的一段内容。请只输出一个 0 到 100 的整数，"
        "表示这段内容有多符合这个人格的语气、风格与价值观（100=完全像，0=完全不像）。"
        "不要输出任何其他文字。\n\n===人格设定===\n设定{x}\n\n===产出内容===\n产出"
    )


def test_the_judge_sends_the_prompt_on_stdin_with_a_scrubbed_env() -> None:
    runner = RecordingRunner("87")
    assert Judge(runner, "opus").score("REF", "OUT") == 87
    call = runner.calls[0]
    assert call.argv == judge_argv("opus")
    assert call.stdin == judge_prompt("REF", "OUT")
    assert call.env == dict.fromkeys(SCRUBBED_ENV, "")
    assert_isolated_cwd(call)
    assert set(SCRUBBED_ENV) == {
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_MODEL",
        "CLAUDE_CODE_EFFORT_LEVEL",
    }


def test_the_scrubbed_env_really_reaches_the_child_without_the_deepseek_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """S3 Review Focus 4, end to end through `SubprocessRunner`: a caller
    shell configured for DeepSeek, and the judge's child sees none of it.
    The child is the Python interpreter, never a real LLM CLI."""
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://api.deepseek.com/anthropic")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "sk-deepseek")
    monkeypatch.setenv("ANTHROPIC_MODEL", "deepseek-v4-flash")
    monkeypatch.setenv("CLAUDE_CODE_EFFORT_LEVEL", "medium")
    monkeypatch.setenv("SWIL_BENCH_PROBE", "kept")
    keys = [*SCRUBBED_ENV, "SWIL_BENCH_PROBE"]
    probe = f"import json, os; print(json.dumps({{k: os.environ.get(k) for k in {keys!r}}}))"
    seen = json.loads(SubprocessRunner().run([sys.executable, "-c", probe], env=judge_env()))
    assert seen == {**dict.fromkeys(SCRUBBED_ENV), "SWIL_BENCH_PROBE": "kept"}


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("87", 87), ("评分：92 分", 92), ("0", 0), ("100", 100), ("3 then 99", 3)],
)
def test_parse_judge_takes_the_first_integer(raw: str, expected: int) -> None:
    assert parse_judge(raw) == expected


@pytest.mark.parametrize("raw", ["", "很像", "120", "101"])
def test_parse_judge_is_null_with_no_integer_or_over_100(raw: str) -> None:
    assert parse_judge(raw) is None


def test_an_out_of_range_judge_answer_is_null_with_a_warn(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.WARNING, logger="swil_agent.bench.judge"):
        assert Judge(RecordingRunner("120"), "sonnet").score("R", "O") is None
    assert "judgeScore is null" in caplog.text


def test_a_failed_judge_call_is_null_with_a_warn(caplog: pytest.LogCaptureFixture) -> None:
    class MissingClaude:
        def run_result(self, argv, stdin=None, env=None, timeout=300.0, cwd=None):  # type: ignore[no-untyped-def]
            raise BackendBinaryMissingError("executable not found on PATH: 'claude'")

    with caplog.at_level(logging.WARNING, logger="swil_agent.bench.judge"):
        assert Judge(MissingClaude()).score("R", "O") is None  # type: ignore[arg-type]
        # A CLI that exited 0 with nothing on stdout.
        assert Judge(RecordingRunner("")).score("R", "O") is None
        assert Judge(RecordingRunner("80", timed_out=True)).score("R", "O") is None
    assert caplog.text.count("judgeScore is null") == 3
    assert "timed out" in caplog.text


def test_a_non_zero_judge_exit_is_null_whatever_stdout_says(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """§12.19's "failed call": `SubprocessRunner.run` returns stdout even on a
    non-zero exit, and a usage-limit notice carries an integer. The judge
    reads the exit status (`run_result`), so this is null, never a 3."""
    runner = RecordingRunner("limit reached, resets at 3pm", returncode=1)
    with caplog.at_level(logging.WARNING, logger="swil_agent.bench.judge"):
        assert Judge(runner, "sonnet").score("R", "O") is None
    assert "exited 1 -- judgeScore is null" in caplog.text
    assert runner.calls[0].timeout == 300.0

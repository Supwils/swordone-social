"""The bench's LLM judge: a 0-100 "how on-character is this" score.

**The argv is `benchmark-run.sh:125`'s, exactly** (S3 §12.19):

    claude --model <judge-model> -p --tools "" --output-format text

with the prompt on stdin and NO `--system-prompt`. That is why this is a
dedicated call over the `Runner` and not `ClaudeCLIBackend`, which always
sends `--system-prompt` -- and an explicit system prompt, even an empty one,
replaces Claude Code's default, so every score after the port would stop being
one series with the scores before it.

**Two invariants, each pinned by a test:**

  * `--tools ""` -- the judge scores text; it has no business writing files.
    Without the flag `claude -p` is the full agent with Write/Edit/Bash and,
    from this repo's cwd, no permission prompt (the 2026-08-19 incident that
    `llm/backends/claude.py` documents).
  * **The judge always reaches real Anthropic.** It must not be routed
    through the backend under test -- DeepSeek would grade DeepSeek's own
    output -- and it must not inherit a DeepSeek-configured shell either. So
    its subprocess env drops the four variables a DeepSeek-configured shell
    exports (`SubprocessRunner` treats an empty value as "unset").
"""

from __future__ import annotations

import logging
import re
from typing import Final

from swil_agent.llm.errors import BackendBinaryMissingError
from swil_agent.llm.runner import DEFAULT_TIMEOUT, StatusRunner

logger = logging.getLogger(__name__)

DEFAULT_JUDGE_MODEL: Final = "sonnet"
MAX_JUDGE_SCORE: Final = 100

# The variables a DeepSeek-configured shell exports (see `DeepSeekCLIBackend`), each
# of which would point a `claude -p` somewhere other than real Anthropic.
SCRUBBED_ENV: Final = (
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_MODEL",
    "CLAUDE_CODE_EFFORT_LEVEL",
)

# `benchmark-run.sh:120`, verbatim. Assembled by concatenation, not
# `str.format`, so a brace in a persona's text cannot break it (the Bash
# `printf '%s'` substituted its arguments literally too).
_JUDGE_HEAD: Final = (
    "下面是一个 AI 人格的设定，以及它产出的一段内容。请只输出一个 0 到 100 的整数，"
    "表示这段内容有多符合这个人格的语气、风格与价值观（100=完全像，0=完全不像）。"
    "不要输出任何其他文字。\n\n===人格设定===\n"
)
_JUDGE_MIDDLE: Final = "\n\n===产出内容===\n"
_FIRST_INTEGER: Final = re.compile(r"[0-9]+")


def judge_prompt(reference: str, output: str) -> str:
    return f"{_JUDGE_HEAD}{reference}{_JUDGE_MIDDLE}{output}"


def judge_argv(model: str) -> list[str]:
    return ["claude", "--model", model, "-p", "--tools", "", "--output-format", "text"]


def judge_env() -> dict[str, str]:
    """Every scrubbed variable mapped to `""`: removed from the child's env."""
    return dict.fromkeys(SCRUBBED_ENV, "")


def parse_judge(raw: str) -> int | None:
    """The first run of ASCII digits (`grep -oE '[0-9]+' | head -1`). Over
    100 is `None`, never clamped: the server's schema caps `judgeScore` at
    100, so Bash's forwarded 120 lost the whole row to a 400."""
    match = _FIRST_INTEGER.search(raw)
    if match is None:
        return None
    value = int(match.group(0))
    return value if value <= MAX_JUDGE_SCORE else None


class Judge:
    """Scores one output against a persona's reference text.

    Needs a `StatusRunner` (`run_result`): a failed call is decided by the
    EXIT STATUS, never by stdout -- a `claude` that exited non-zero can still
    print an integer ("5-hour limit reached, resets at 3pm"), and filing that
    3 as a score is worse than filing nothing. Runs under the round's
    `DEFAULT_TIMEOUT`; only the model under test gets the bench timeout.
    """

    def __init__(self, runner: StatusRunner, model: str = DEFAULT_JUDGE_MODEL) -> None:
        self._runner = runner
        self.model = model

    def score(self, reference: str, output: str) -> int | None:
        """The judge's score, or `None` with a WARN when the call fails (no
        binary, a non-zero exit, a timeout), the answer has no integer, or
        the integer is over 100."""
        try:
            result = self._runner.run_result(
                judge_argv(self.model),
                stdin=judge_prompt(reference, output),
                env=judge_env(),
                timeout=DEFAULT_TIMEOUT,
            )
        except BackendBinaryMissingError as exc:
            logger.warning("WARN judge: %s -- judgeScore is null", exc)
            return None
        if result.timed_out or result.returncode != 0:
            status = "timed out" if result.timed_out else f"exited {result.returncode}"
            logger.warning("WARN judge (%s) %s -- judgeScore is null", self.model, status)
            return None
        raw = result.stdout
        score = parse_judge(raw)
        if score is None:
            logger.warning(
                "WARN judge (%s) gave no score in 0-%d: %r -- judgeScore is null",
                self.model,
                MAX_JUDGE_SCORE,
                raw[:80],
            )
        return score

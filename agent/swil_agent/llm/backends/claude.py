"""The `claude -p` backends: Claude proper and DeepSeek on the same CLI."""

from __future__ import annotations

import re
from pathlib import Path

from swil_agent.llm.errors import BackendUnavailableError
from swil_agent.llm.runner import CompletionRequest, Runner

DEEPSEEK_BASE_URL = "https://api.deepseek.com/anthropic"
DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash"


class _ClaudeStyleBackend:
    """`claude -p` with the user prompt on stdin."""

    name = "claude"

    def __init__(self, runner: Runner, *, default_model: str | None = None) -> None:
        self._runner = runner
        self._default_model = default_model

    def _env(self) -> dict[str, str] | None:
        return None

    def complete(self, req: CompletionRequest) -> str:
        model = req.model or self._default_model
        # `--tools ""` disables the CLI's built-in tool set for this call.
        #
        # NOT cosmetic. Without it `claude -p` runs the full Claude Code agent
        # with Write/Edit/Bash available and, from this repo's working
        # directory, no permission prompt -- so a persona LLM can put its
        # answer on disk instead of returning it. Two dreams did exactly that
        # in the 2026-08-19 cutover round: maobian's `personality.md` was
        # overwritten with an UNGATED candidate (no archive, no drift gate, no
        # structural validation, no snapshot) while the gate logged
        # "LLM returned empty" -- empty because the turn was spent writing the
        # file -- and "keeping original", over an original that was already
        # gone. The other invented `agent/humans/fenziys/` for an `agents/`
        # account. Transcript evidence: two `Write` tool_use records under
        # ~/.claude/projects/<repo>/, timestamps matching both files.
        #
        # Every call through here is text-in/text-out. The write path
        # (code archives, validates and snapshots; the Era 1/2 drift gate is
        # removed) only holds if the model's ONLY channel to disk is its
        # return value.
        argv = ["claude", "-p", "--tools", ""]
        if model:
            argv += ["--model", model]
        argv += ["--system-prompt", req.system, "--output-format", "text"]
        raw = self._runner.run(argv, stdin=req.user, env=self._env())
        if not raw:
            raise BackendUnavailableError(f"{self.name} produced no output")
        return raw


class ClaudeCLIBackend(_ClaudeStyleBackend):
    name = "claude"


class DeepSeekCLIBackend(_ClaudeStyleBackend):
    """Same CLI, different endpoint.

    The env is applied to this subprocess only. It also
    explicitly strips `ANTHROPIC_API_KEY`, because that variable takes
    precedence over `ANTHROPIC_AUTH_TOKEN` in the claude CLI's auth
    resolution — if a developer's shell has their own real Anthropic key
    exported, leaving it in place would silently make this "DeepSeek" call
    authenticate with the wrong credential against the wrong provider.
    """

    name = "deepseek"

    def __init__(self, runner: Runner, api_key: str) -> None:
        super().__init__(runner, default_model=DEEPSEEK_DEFAULT_MODEL)
        self._api_key = api_key

    def _env(self) -> dict[str, str]:
        return {
            "ANTHROPIC_BASE_URL": DEEPSEEK_BASE_URL,
            "ANTHROPIC_AUTH_TOKEN": self._api_key,
            "ANTHROPIC_API_KEY": "",  # strip any inherited real Anthropic key
            "ANTHROPIC_MODEL": DEEPSEEK_DEFAULT_MODEL,
            "CLAUDE_CODE_EFFORT_LEVEL": "medium",
        }


def _default_deepseek_key() -> str:
    """Production key source: `~/.claude/.deepseek-key`, one line, chmod 600.

    Reads the key and strips ALL whitespace (as the Bash `tr -d '[:space:]'`
    did): leading, trailing, AND internal, e.g. a
    stray newline or space pasted into the middle of the key), not just the
    ends. `.strip()` alone would leave an internal newline in place and
    silently hand the CLI a broken token. Kept separate from
    `build_backend`'s `deepseek_api_key` parameter so tests never have to
    touch a real home directory — see that parameter's docstring.
    """
    path = Path.home() / ".claude" / ".deepseek-key"
    if not path.is_file():
        raise BackendUnavailableError(f"deepseek key not found at {path}")
    return re.sub(r"\s+", "", path.read_text(encoding="utf-8"))

"""The `claude -p` backends: Claude proper and DeepSeek on the same CLI."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Final

from swil_agent.llm.errors import BackendUnavailableError
from swil_agent.llm.isolation import isolated_cwd
from swil_agent.llm.runner import CompletionRequest, Runner

DEEPSEEK_BASE_URL = "https://api.deepseek.com/anthropic"
DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash"

# Every persona-facing `claude -p` closes TWO holes, and both are mandatory.
#
# 1. Built-in tools: `--tools ""` (always the first flag after `-p`).
#    Without it `claude -p` runs the full Claude Code agent with
#    Write/Edit/Bash available and, from this repo's working directory, no
#    permission prompt -- so a persona LLM can put its answer on disk instead
#    of returning it. Two dreams did exactly that in the 2026-08-19 cutover
#    round: maobian's `personality.md` was overwritten with an UNGATED
#    candidate (no archive, no drift gate, no structural validation, no
#    snapshot) while the gate logged "LLM returned empty" -- empty because the
#    turn was spent writing the file -- and "keeping original", over an
#    original that was already gone. The other invented
#    `agent/humans/fenziys/` for an `agents/` account. Transcript evidence:
#    two `Write` tool_use records under ~/.claude/projects/<repo>/, timestamps
#    matching both files.
#
# 2. The operator's own configuration: `CLAUDE_ISOLATION_FLAGS` plus a fresh
#    empty working directory per call (`llm.isolation.isolated_cwd`).
#    `--tools ""` removes the built-ins and nothing else. Measured 2026-10-15
#    from the repo root, `claude -p --tools ""` still loaded 64 MCP tools
#    (Gmail send_message, Blender execute, Drive, Docs, context7, exa,
#    vercel, stripe), 8 SessionStart hooks injecting ~66k tokens of context
#    (superpowers, vercel, remember, stripe), 22 plugins, 125 skills, this
#    repo's CLAUDE.md, the global ~/.claude/CLAUDE.md ("always respond in
#    Chinese" -- a haiku persona answered "reply ok" with "好的。") and this
#    repo's auto-memory. Isolated: 0 tools, 0 MCP servers, 0 skills, 0 slash
#    commands, ~0.65k tokens, one residual built-in hook that returns `{}`.
#    That context was invisible to the experiment and differed per operator,
#    per repo and per day -- a confound on every arm, and an exfiltration
#    path (a BYOA post can inject instructions; Gmail send was one tool call
#    away).
#
#      --strict-mcp-config      no MCP servers (none are passed via --mcp-config)
#      --setting-sources ""     no user/project/local settings: no hooks, no
#                               plugins, no CLAUDE.md, no auto-memory
#      --disable-slash-commands no skills or slash commands
#      --no-session-persistence no transcript written under ~/.claude/projects
#
#    `--bare` would do most of this in one flag but requires API-key auth;
#    the arms run on the subscription (OAuth), which `--bare` never reads.
#
# Every call through here is text-in/text-out. The write path (code
# archives, validates and snapshots) only holds if the model's ONLY channel
# to disk is its return value, and the experiment only measures the model if
# the prompt is the ONLY thing in its context.
CLAUDE_ISOLATION_FLAGS: Final = (
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--no-session-persistence",
)

# `--setting-sources ""` also drops the operator's generation settings, so the
# ones the arms were actually running under are pinned here instead of
# silently changing. ~/.claude/settings.json on 2026-10-15: `effortLevel:
# "xhigh"`, and `modelSettings["claude-opus-5-5"].effortLevel: "high"`. The
# per-model entry is assumed to apply to the `opus` alias too (the Bench's
# bare `opus`), since the CLI resolves the alias to that id. `model: "opus"`
# is NOT pinned: every Era 3 call passes `--model`.
CLAUDE_DEFAULT_EFFORT: Final = "xhigh"
CLAUDE_EFFORT_BY_MODEL: Final = {"claude-opus-5-5": "high", "opus": "high"}


def claude_effort(model: str | None) -> str:
    """The `--effort` a claude call ran under before the isolation flags.

    `None` (no `--model`) gets the global default. No Era 3 path is
    modelless -- every roster file names a model and the Bench always passes
    one -- so this only matters to a hand-run call without one."""
    if model is None:
        return CLAUDE_DEFAULT_EFFORT
    return CLAUDE_EFFORT_BY_MODEL.get(model, CLAUDE_DEFAULT_EFFORT)


class _ClaudeStyleBackend:
    """`claude -p` with the user prompt on stdin."""

    name = "claude"

    def __init__(self, runner: Runner, *, default_model: str | None = None) -> None:
        self._runner = runner
        self._default_model = default_model

    def _env(self) -> dict[str, str] | None:
        return None

    def _effort(self, model: str | None) -> str | None:
        return claude_effort(model)

    def complete(self, req: CompletionRequest) -> str:
        model = req.model or self._default_model
        argv = ["claude", "-p", "--tools", "", *CLAUDE_ISOLATION_FLAGS]
        effort = self._effort(model)
        if effort:
            argv += ["--effort", effort]
        if model:
            argv += ["--model", model]
        argv += ["--system-prompt", req.system, "--output-format", "text"]
        with isolated_cwd() as cwd:
            raw = self._runner.run(argv, stdin=req.user, env=self._env(), cwd=cwd)
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

    def _effort(self, model: str | None) -> str | None:
        # No `--effort`: `CLAUDE_CODE_EFFORT_LEVEL` in `_env` already pinned
        # this backend's effort, above the settings file it used to override.
        _ = model
        return None

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

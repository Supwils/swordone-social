"""The `grok -p` backend."""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from typing import Final

from swil_agent.llm.errors import BackendConfigurationError, BackendUnavailableError
from swil_agent.llm.runner import CompletionRequest, Runner

# `--tools ""` does NOT empty grok's toolset (grok 1.0.52, measured
# 2026-10-15 from the `streaming-messages-json` init event): an empty
# allowlist reads as "no allowlist", and the persona call still carried 24
# built-ins, among them `run_terminal_command`, `read_file` and `write`. The
# denylist does empty it (`tools: []`, 21322 -> 12350 input tokens for
# "reply ok"). `--tools ""` stays on the argv as the documented intent and in
# case a later grok honours it; this list is what actually closes the hole.
# `search_tool` / `use_tool` are the MCP meta-tools -- denying them is what
# keeps a configured MCP server's tools out of reach. A NEW built-in in a
# later grok is not on this list: re-read the init event after an upgrade
# (`doctor` enforces it via `GROK_AUDITED_VERSION`).
# The grok version `GROK_DISALLOWED_TOOLS` was read from. `swil-agent doctor`
# FAILs on any other version: a built-in added since is NOT denied.
GROK_AUDITED_VERSION: Final = "1.0.52"

GROK_DISALLOWED_TOOLS: Final = (
    "run_terminal_command",
    "read_file",
    "search_replace",
    "list_dir",
    "grep",
    "kill_command_or_subagent",
    "todo_write",
    "get_command_or_subagent_output",
    "scheduler_create",
    "scheduler_delete",
    "scheduler_list",
    "monitor",
    "search_tool",
    "use_tool",
    "workflow",
    "enter_plan_mode",
    "exit_plan_mode",
    "ask_user_question",
    "send_feedback",
    "image_gen",
    "image_edit",
    "image_to_video",
    "reference_to_video",
    "write",
)

# grok scans Claude Code's and Cursor's home config by default ("harness
# compatibility"). Measured 2026-10-15: a persona call loaded the `blender`
# MCP server from ~/.claude.json (connected -- Blender `execute` one call
# away), ~/.claude/skills, ~/.cursor/{rules,skills,hooks.json} and the global
# commit-style rule. Every compat cell is documented as overridable by these
# env vars (env > config.toml), so they are set per call instead of editing
# the operator's ~/.grok/config.toml. `GROK_MEMORY=0` force-disables
# cross-session memory (off by default, but a TOML or remote setting can turn
# it on). Not reachable by any switch: grok's OWN home -- ~/.grok/rules,
# ~/.grok/skills, ~/.grok/hooks -- and skills/MCP/hooks from installed
# plugins; moving GROK_HOME would move auth.json with it.
GROK_ISOLATION_ENV: Final = {
    "GROK_CLAUDE_AGENTS_ENABLED": "false",
    "GROK_CLAUDE_HOOKS_ENABLED": "false",
    "GROK_CLAUDE_MCPS_ENABLED": "false",
    "GROK_CLAUDE_RULES_ENABLED": "false",
    "GROK_CLAUDE_SKILLS_ENABLED": "false",
    "GROK_CURSOR_AGENTS_ENABLED": "false",
    "GROK_CURSOR_HOOKS_ENABLED": "false",
    "GROK_CURSOR_MCPS_ENABLED": "false",
    "GROK_CURSOR_RULES_ENABLED": "false",
    "GROK_CURSOR_SKILLS_ENABLED": "false",
    "GROK_MEMORY": "0",
}


class GrokCLIBackend:
    """`grok -p`, reached through the maintainer's grok.com subscription.

    This is a CLI backend, not `ApiBackend` with `provider=xai`. grok.com
    OAuth is not an xAI API key, and the two must not be collapsed: a missing
    `SWIL_LLM_API_KEY` is the live config on this machine, while `grok models`
    already shows the operator logged in. The binary is Grok Build TUI
    (`grok` 1.0.5). Verified against it on 2026-08-25:

      * `grok -p PROMPT --tools "" --max-turns 8 --no-subagents --no-plan
        --permission-mode plan -m grok-4.6 --system-prompt-override SYS`
        prints the model text on stdout and exits 0.
      * `--tools ""` is a real flag (unlike cursor-agent) -- but on grok
        1.0.52 it no longer empties the toolset; `--disallowed-tools` does
        (see `GROK_DISALLOWED_TOOLS`), so the "only channel to disk is the
        return value" guarantee still lives in the argv.

    Extra containment, rebuilt per call rather than trusted from the
    environment:

      * `--permission-mode plan` (read-only). `bypassPermissions` / `auto` /
        `acceptEdits` / `dontAsk` / `--always-approve` are never passed.
      * `--max-turns 8 --no-subagents --no-plan --disable-web-search`
        (`1` is too tight: grok spends a turn probing the empty cwd and
        then exits `Max turns reached` with no text. Measured 2026-08-25
        on the first `_g` fork round.)
      * `--cwd` is a fresh empty temp directory, and the process starts
        there too. The repository is never it.
      * `GROK_ISOLATION_ENV` turns off the Claude/Cursor config scan.

    An explicit model is required. The CLI default is currently `grok-4.6`,
    which is a real named model (unlike cursor's `auto` router), but a
    missing model half would still record a flat `grok` on the wire while
    that default can move on a grok.com deploy.
    """

    name = "grok"

    def __init__(self, runner: Runner, *, default_model: str | None = None) -> None:
        self._runner = runner
        self._default_model = default_model

    def complete(self, req: CompletionRequest) -> str:
        model = req.model or self._default_model
        if not model:
            raise BackendConfigurationError(
                "the grok backend requires an explicit model -- set SWIL_LLM_MODEL, "
                "pass --model, or give the account a `model: <backend>:<model>` frontmatter line "
                "(`grok models` shows the ids)"
            )
        workspace = Path(tempfile.mkdtemp(prefix="swil_grok_"))
        try:
            raw = self._runner.run(
                [
                    "grok",
                    "-p",
                    req.user,
                    "--output-format",
                    "plain",
                    "--max-turns",
                    "8",
                    "--no-subagents",
                    "--no-plan",
                    "--tools",
                    "",
                    "--disallowed-tools",
                    ",".join(GROK_DISALLOWED_TOOLS),
                    "--permission-mode",
                    "plan",
                    "--disable-web-search",
                    "-m",
                    model,
                    "--system-prompt-override",
                    req.system,
                    "--cwd",
                    str(workspace),
                ],
                env=dict(GROK_ISOLATION_ENV),
                timeout=600.0,
                cwd=str(workspace),
            )
        finally:
            shutil.rmtree(workspace, ignore_errors=True)
        if not raw:
            raise BackendUnavailableError("grok produced no output")
        return raw

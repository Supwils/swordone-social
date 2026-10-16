"""The `codex exec` backend."""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Final

from swil_agent.llm.errors import BackendUnavailableError
from swil_agent.llm.isolation import isolated_cwd
from swil_agent.llm.runner import CompletionRequest, Runner

# The generation settings the codex arm ran under, pinned because
# `--ignore-user-config` drops ~/.codex/config.toml, where they used to come
# from (read 2026-10-15). Kept, as values the arm was actually getting:
#
#   model_reasoning_effort = "high"  changes the model's reasoning.
#   service_tier = "priority"        changes latency, not text -- pinned so
#                                    the 1800 s round cap and the Bench's
#                                    `latencyMs` keep meaning what they meant.
#
# Dropped on purpose, as operator contamination: `personality = "pragmatic"`
# (a style instruction in the persona's context), `[mcp_servers.*]`
# (`node_repl` -- a JS REPL tool), `notify`, plugins, hooks, `approvals_reviewer`.
# Not pinned because they cannot bind a one-turn exec of a ~13k-token prompt:
# `model_context_window` (500000) and `model_auto_compact_token_limit`
# (400000). `model` ("gpt-6.1-sol") is not pinned either: every Era 3 codex
# call passes `-m`, and a modelless call means "the CLI default" by contract.
CODEX_PINNED_CONFIG: Final = (
    "model_reasoning_effort=high",
    "service_tier=priority",
)


# `-C <tmp>` moves the working root; it does not stop a read by ABSOLUTE
# path. Measured 2026-10-15 with the argv above and a canary file outside the
# temp dir: the persona call ran two `command_execution` items under
# `-s read-only` and printed the canary's random token (read-only stops
# writes, not reads -- `agent/.env` and every `api_key.txt` were in reach,
# and a persona's output is a public post). With shell_tool, plugins and
# hooks disabled the shell was gone, but the model reached for the
# account-level `codex_apps` MCP server (ChatGPT connectors) and ran a web
# search for `file:///...canary.txt`. With this whole list: the canary read
# fails (empty answer, token absent), "reply ok" still answers "ok", and the
# input for "reply ok" drops 13095 -> 7243 tokens. Residual built-ins no
# flag here removes: `apply_patch` (blocked by `-s read-only`), `view_image`
# (images only -- it refused the text canary), `image_gen`, the multi-agent
# tools and `functions.exec`.
CODEX_TOOL_LOCKDOWN: Final = (
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
)


class CodexCLIBackend:
    """`codex exec` writes to a file; stdout is progress noise."""

    name = "codex"

    def __init__(self, runner: Runner) -> None:
        self._runner = runner

    def complete(self, req: CompletionRequest) -> str:
        prompt = f"System:\n{req.system}\n\n---\n\n{req.user}"
        # NamedTemporaryFile generates a unique name per call, so concurrent
        # image posts cannot collide on one output path.
        with tempfile.NamedTemporaryFile(
            prefix="swil_codex_", suffix=".txt", delete=False
        ) as handle:
            out_path = Path(handle.name)
        try:
            with isolated_cwd() as cwd:
                argv = [
                    "codex",
                    "exec",
                    "--ephemeral",
                    "--skip-git-repo-check",
                    # Isolation from the operator, the codex half of the
                    # `CLAUDE_ISOLATION_FLAGS` comment in `claude.py`. From
                    # this repo with the user config, a persona call ran the
                    # operator's SessionStart/UserPromptSubmit hooks, carried
                    # the `node_repl` MCP tool and `personality = "pragmatic"`,
                    # loaded the execpolicy `.rules` (which allow-list a
                    # `source .env && curl $SWIL_URL/...login` command), and
                    # could `cat agent/.env` from its working root. Measured
                    # 2026-10-15: 16058 -> 13095 input tokens for "reply ok",
                    # no hooks, no `mcp__` tool, auth unchanged.
                    #
                    # NOT closed by any flag: `$CODEX_HOME/AGENTS.md` is still
                    # loaded (`--ignore-user-config` skips only config.toml,
                    # and moving CODEX_HOME would move auth.json with it).
                    "--ignore-user-config",
                    "--ignore-rules",
                    "-C",
                    cwd,
                ]
                for setting in CODEX_PINNED_CONFIG:
                    argv += ["-c", setting]
                argv += [*CODEX_TOOL_LOCKDOWN]
                argv += [
                    # `--full-auto` is `-s workspace-write` plus auto-approval:
                    # it let a persona model edit this repo. Same exposure the
                    # claude path had, and the same reason it is wrong -- see
                    # the `--tools ""` comment in `claude.py`. `-o` is written
                    # by the CLI itself, not by the model, so it still works
                    # read-only (verified against the real binary 2026-08-19).
                    "-s",
                    "read-only",
                    "--color",
                    "never",
                ]
                # `-m` is how Luna/Terra/Sol actually run. Omitting it when the
                # persona declares a model would record `codex:gpt-5.6-luna` on
                # the wire while the CLI used its own default -- the same class
                # of silent independent-variable drift cursor's `auto` is
                # refused for. No model still omits the flag, so the four
                # historical modelless codex accounts keep the CLI default.
                if req.model:
                    argv += ["-m", req.model]
                argv += ["-o", str(out_path), prompt]
                self._runner.run(argv, cwd=cwd)
            raw = out_path.read_text(encoding="utf-8") if out_path.exists() else ""
        finally:
            out_path.unlink(missing_ok=True)
        if not raw:
            raise BackendUnavailableError("codex produced no output")
        return raw

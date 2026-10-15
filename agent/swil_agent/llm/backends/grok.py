"""The `grok -p` backend."""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from swil_agent.llm.errors import BackendConfigurationError, BackendUnavailableError
from swil_agent.llm.runner import CompletionRequest, Runner


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
      * `--tools ""` is a real flag (unlike cursor-agent), so the
        constitution layer's "only channel to disk is the return value"
        guarantee can live in the argv the same way it does for
        `claude -p --tools ""`.

    Extra containment, rebuilt per call rather than trusted from the
    environment:

      * `--permission-mode plan` (read-only). `bypassPermissions` / `auto` /
        `acceptEdits` / `dontAsk` / `--always-approve` are never passed.
      * `--max-turns 8 --no-subagents --no-plan --disable-web-search`
        (`1` is too tight: grok spends a turn probing the empty cwd and
        then exits `Max turns reached` with no text. Measured 2026-08-25
        on the first `_g` fork round.)
      * `--cwd` is a fresh empty temp directory. The repository is never it.

    An explicit model is required. The CLI default is currently `grok-4.6`,
    which is a real named model (unlike cursor's `auto` router), but a
    missing Model bullet would still record a flat `grok` on the wire while
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
                "pass --model, or give the account a `- **Model:**` bullet "
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
                timeout=600.0,
            )
        finally:
            shutil.rmtree(workspace, ignore_errors=True)
        if not raw:
            raise BackendUnavailableError("grok produced no output")
        return raw

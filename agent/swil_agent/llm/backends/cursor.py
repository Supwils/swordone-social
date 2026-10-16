"""The `cursor-agent -p` backend and its per-call deny config."""

from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path
from typing import Final

from swil_agent.llm.errors import BackendConfigurationError, BackendUnavailableError
from swil_agent.llm.runner import CompletionRequest, Runner


class CursorCLIBackend:
    """`cursor-agent -p`, reached through the maintainer's Cursor subscription.

    One credential reaches five vendors (Anthropic, OpenAI, xAI, Google, and
    Cursor's own Composer), which is the whole reason this backend exists: the
    roster's model-tier arms are the drift experiment's independent variable,
    and every vendor beyond Anthropic previously needed its own key.

    **This backend has no `--tools ""`, because cursor-agent has no such flag.**
    Its own `--help` says of print mode: "Has access to all tools, including
    write and shell." That is the identical exposure `claude -p` had on
    2026-08-19, when two dreams wrote `personality.md` straight to disk and the
    constitution layer (archive -> drift gate -> validators -> snapshot) was
    reduced to a suggestion. Measured against the real binary on 2026-08-21, an
    unguarded call created a file on the first try.

    So the guarantee is rebuilt out of three parts, and all three are per-call:

      1. `--mode ask` on the argv. Read-only Q&A mode. Verified to refuse, but
         it refuses in the MODEL'S voice ("I am in Ask mode, I cannot create
         files"), which makes it a system-prompt-level refusal -- the soft lock.
      2. A deny-everything permission config written into the workspace
         immediately before every call. Verified to refuse in the RUNTIME'S
         voice ("Permission denied: Command blocked by permissions
         configuration") while under `--force` AND a prompt explicitly telling
         the model to ignore its read-only instruction -- the hard lock.
      3. A fresh empty temp directory as the workspace. If both locks somehow
         failed there is nothing in reach to damage: the repository is never the
         workspace, and the directory is removed when the call returns.

    The config is rewritten on EVERY call rather than shipped as a file in the
    repo. A checked-in config is ambient state -- editable, deletable, and
    silently permissive once it drifts -- where the other backends' guarantee
    lives in the argv and is therefore reconstructed from scratch every time.
    Writing it per call is what restores that property. (The maintainer's own
    `~/.cursor/cli-config.json` is left alone, and is currently `"deny": []`
    with several `Shell(...)` entries allowed -- which is exactly why this
    backend must not depend on the global config.)

    `--force` / `--yolo` are never passed, and there is no code path here that
    can add them.
    """

    name = "cursor"

    # Verified against the real binary. The project-local schema is STRICTER
    # than `~/.cursor/cli-config.json`'s -- a stray `"version"` key makes
    # cursor-agent exit with `Unrecognized key(s) in object`, killing the call
    # rather than silently ignoring the config. Loud, and worth keeping loud:
    # a permission file that fails open is the whole hazard.
    DENY: Final = ("Shell(*)", "Write(**)")

    def __init__(self, runner: Runner, *, default_model: str | None = None) -> None:
        self._runner = runner
        self._default_model = default_model

    def complete(self, req: CompletionRequest) -> str:
        model = req.model or self._default_model
        if not model:
            # `cursor-agent` with no `--model` silently uses its `auto` router,
            # which picks a different model whenever Cursor changes the routing
            # -- while `agentBackend` would still read a flat `cursor`. An
            # experiment whose independent variable can move on someone else's
            # deploy is not measuring what it says it measures.
            raise BackendConfigurationError(
                "the cursor backend requires an explicit model -- `auto` would let "
                "the routed model change without the recorded agentBackend changing"
            )
        workspace = Path(tempfile.mkdtemp(prefix="swil_cursor_"))
        try:
            self._write_deny_config(workspace)
            # No `--system-prompt` flag exists, so system and user are joined
            # into one prompt exactly the way `CodexCLIBackend` does. Both
            # backends therefore present the persona differently from the
            # claude path -- a known cross-backend confound, recorded rather
            # than hidden.
            prompt = f"System:\n{req.system}\n\n---\n\n{req.user}"
            raw = self._runner.run(
                [
                    "cursor-agent",
                    "-p",
                    "--output-format",
                    "text",
                    # Lock 1 of 3 -- see the class docstring.
                    "--mode",
                    "ask",
                    "--model",
                    model,
                    # Lock 3 of 3: an empty temp dir, never the repository.
                    "--workspace",
                    str(workspace),
                    # Suppresses the interactive "trust this folder?" prompt,
                    # which would otherwise block a non-interactive round
                    # forever. It grants nothing here: the folder is empty and
                    # the deny config governs the tools regardless.
                    "--trust",
                    prompt,
                ],
                # The process starts there too, not only the agent's
                # workspace: the CLI itself never runs from the repository.
                cwd=str(workspace),
            )
        finally:
            shutil.rmtree(workspace, ignore_errors=True)
        if not raw:
            raise BackendUnavailableError("cursor produced no output")
        return raw

    def _write_deny_config(self, workspace: Path) -> None:
        """Lock 2 of 3, rebuilt immediately before every call."""
        config_dir = workspace / ".cursor"
        config_dir.mkdir(parents=True, exist_ok=True)
        (config_dir / "cli.json").write_text(
            json.dumps({"permissions": {"allow": [], "deny": list(self.DENY)}}),
            encoding="utf-8",
        )

"""The `codex exec` backend."""

from __future__ import annotations

import tempfile
from pathlib import Path

from swil_agent.llm.errors import BackendUnavailableError
from swil_agent.llm.runner import CompletionRequest, Runner


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
            argv = [
                "codex",
                "exec",
                "--ephemeral",
                "--skip-git-repo-check",
                # `--full-auto` is `-s workspace-write` plus auto-approval:
                # it let a persona model edit this repo. Same exposure the
                # claude path had, and the same reason it is wrong -- see
                # the `--tools ""` comment above. `-o` is written by the
                # CLI itself, not by the model, so it still works
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
            self._runner.run(argv)
            raw = out_path.read_text(encoding="utf-8") if out_path.exists() else ""
        finally:
            out_path.unlink(missing_ok=True)
        if not raw:
            raise BackendUnavailableError("codex produced no output")
        return raw

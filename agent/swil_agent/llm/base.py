"""Backend dispatch for LLM calls.

All three current backends are CLI subprocesses, not HTTP APIs — `codex` has no
API at all. `Runner` is the seam that makes them testable: production uses
`SubprocessRunner`, tests inject a fake.

An `ApiBackend` for BYOK (owner-supplied keys against real HTTP APIs) will sit
beside these implementations; it is Plan 2+ and deliberately absent here.

Ports `agent/scripts/llm.sh:80-124` (`_llm_raw`, `llm_text`, `llm_json`).
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Final, Protocol

from pydantic import BaseModel

from swil_agent.config import Settings
from swil_agent.llm.extract import collapse_doubled_text, extract_json_object

logger = logging.getLogger(__name__)

DEEPSEEK_BASE_URL = "https://api.deepseek.com/anthropic"
DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash"
DEFAULT_TIMEOUT = 300.0


class BackendUnavailableError(RuntimeError):
    """The backend produced no output, or could not be constructed at all.

    Distinct from a bad/garbled response, which is the caller's problem.
    """


class BackendBinaryMissingError(RuntimeError):
    """argv[0] is not on PATH -- the CLI this backend shells out to is not
    installed on this machine.

    DELIBERATELY NOT a subclass of `BackendUnavailableError`, and that is the
    whole point of it existing. Every "the LLM said nothing" call site --
    `act/planner.py`'s `plan_round`, `dream/round.py`'s `_generate_candidate`
    and `_diff_narrative`, `dream/distill.py`'s `distill_cards` -- catches
    `BackendUnavailableError` and degrades to `None`/`""`, exactly as Bash's
    `llm_text` returns empty for a dead model. That degradation is right for
    a model that answered with nothing and WRONG for a binary that does not
    exist: it turns "codex is not installed" into "codex had nothing to say",
    which is how a whole round can silently drop every account on one backend
    with no loud error (CLAUDE.md's own DeepSeek-key note, and the "no
    response from codex" incidents).

    As a sibling type it passes straight through all of those handlers to the
    composition root, which is the only layer that knows the account name and
    the remedy -- `cli.py`'s `_backend_setup_guard` turns it into an
    `AccountSetupError` and exits 75 with both.
    """


class BackendConfigurationError(RuntimeError):
    """The configuration cannot produce a usable backend, or the provider
    refused the credentials it was given.

    The third sibling of `BackendUnavailableError` and
    `BackendBinaryMissingError`, and deliberately not a subclass of either,
    for the reason spelled out at length on `BackendBinaryMissingError`: every
    "the LLM said nothing" call site catches `BackendUnavailableError` and
    degrades to `None`/`""`. That degradation is right for a model that
    answered with nothing, and wrong for an unknown provider, a missing key,
    or a 401 -- which would otherwise be reported as "the model had nothing to
    say" and cost the same misdirected debugging session the codex and
    DeepSeek incidents already cost this project.

    As a sibling it passes through those handlers untouched to `cli.py`'s
    `_backend_setup_guard`, which is the only layer that knows the account
    name and the remedy.
    """


class CompletionRequest(BaseModel):
    system: str
    user: str
    model: str | None = None


class Runner(Protocol):
    def run(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> str: ...


class SubprocessRunner:
    """The real `Runner`.

    `env` entries with an empty string value are treated as "strip this key
    from the merged environment" rather than "set it to empty". Python's
    subprocess `env=` has no way to express `unset FOO` the way a POSIX shell
    does — a backend that needs to guarantee a var is absent (see
    `DeepSeekCLIBackend`, which must not let an inherited real Anthropic key
    leak into a DeepSeek-endpoint call) has no other lever to pull.
    """

    def run(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> str:
        merged = dict(os.environ)
        for key, value in (env or {}).items():
            if value:
                merged[key] = value
            else:
                merged.pop(key, None)
        try:
            completed = subprocess.run(
                argv,
                input=stdin,
                capture_output=True,
                text=True,
                timeout=timeout,
                env=merged,
                check=False,
            )
        except subprocess.TimeoutExpired:
            # Was a silent `return ""` -- indistinguishable downstream from a
            # backend that answered instantly with nothing. One is a wedged
            # host, the other a broken install, and both surfaced to the
            # operator as the same `outcome=backend_unavailable`.
            logger.warning("WARN %s timed out after %.0fs", argv[0], timeout)
            return ""
        except FileNotFoundError as exc:
            # `subprocess.run` raises `FileNotFoundError` when argv[0] itself
            # is not on PATH. Left raw it escapes as the SAME exception type
            # "this account directory does not exist" uses, and `cli.py`'s
            # `act` reported a missing `claude`/`codex` binary as exit 66,
            # "no such account" -- pointing whoever is debugging at the
            # roster instead of at PATH. This project has already lost real
            # time to "no response from codex" incidents (CLAUDE.md); an
            # exit code naming the wrong thing makes the next one worse.
            #
            # Re-raised as `BackendBinaryMissingError` -- see that class for
            # why it is NOT a `BackendUnavailableError`. Deliberately not
            # `return ""` either: an empty string is indistinguishable from a
            # dead LLM and would cost the same diagnosis.
            raise BackendBinaryMissingError(f"executable not found on PATH: {argv[0]!r}") from exc
        if completed.returncode != 0:
            # The CLI writes WHY it failed to stderr -- "Credit balance too
            # low", "not logged in", a rate-limit notice, a model the
            # installed version does not know. Returning only stdout threw
            # all of that away and left `BackendUnavailableError(... produced
            # no output)` as the operator's whole artefact, which is exactly
            # the "no response from codex" incident class the FileNotFoundError
            # branch above already names. Logged, not raised: the empty return
            # is the existing contract and callers are built on it.
            detail = " ".join((completed.stderr or "").split())[:300]
            logger.warning(
                "WARN %s exited %d%s",
                argv[0],
                completed.returncode,
                f": {detail}" if detail else "",
            )
        return completed.stdout


class Backend(Protocol):
    name: str

    def complete(self, req: CompletionRequest) -> str: ...


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
        # Every call through here is text-in/text-out. The constitution layer
        # (archive -> drift gate -> validators -> snapshot) is only a gate if
        # the model's ONLY channel to disk is its return value.
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

    The env is applied to this process only — it must never leak to the
    neutral ruler (see `llm/neutral.py`). Mirrors `deepseek-env.sh`: it also
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


class CodexCLIBackend:
    """`codex exec` writes to a file; stdout is progress noise."""

    name = "codex"

    def __init__(self, runner: Runner) -> None:
        self._runner = runner

    def complete(self, req: CompletionRequest) -> str:
        prompt = f"System:\n{req.system}\n\n---\n\n{req.user}"
        # Trailing X's so mktemp-style uniqueness actually applies: the Bash
        # `swil.sh` template put its X's in the wrong (non-trailing) position,
        # so concurrent image posts collided on a fixed name and one silently
        # clobbered the other's output. NamedTemporaryFile always generates a
        # unique name per call, so that class of bug cannot recur here.
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
                ]
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


def _default_deepseek_key() -> str:
    """Production key source: `~/.claude/.deepseek-key`, one line, chmod 600.

    Mirrors `deepseek-env.sh`'s own read — including `tr -d '[:space:]'`,
    which strips ALL whitespace (leading, trailing, AND internal, e.g. a
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


def build_backend(
    name: str,
    runner: Runner,
    settings: Settings,
    *,
    deepseek_api_key: str | None = None,
) -> Backend:
    """Map a personality's `AI Backend` bullet to a backend.

    Unknown names fall back to the claude path, matching the `*)` default
    branch in `llm.sh`. `mangniu` records `haiku`, which must not raise.

    `deepseek_api_key` is an injection seam, not a production concern: leave
    it unset and the real key is read from `~/.claude/.deepseek-key` (via
    `_default_deepseek_key`), exactly like the Bash runtime. It exists so
    `test_backends.py` can supply a fixed string instead of depending on a
    file outside the repository — without it, the deepseek tests would pass
    locally (if the developer happens to have the file) and fail in CI (which
    never will). A missing/empty key — injected or read from disk — still
    raises `BackendUnavailableError` rather than building a backend that
    would silently authenticate with nothing.
    """
    _ = settings  # no per-backend settings yet; kept for interface stability
    if name == "codex":
        return CodexCLIBackend(runner)
    if name == "cursor":
        return CursorCLIBackend(runner)
    if name == "grok":
        return GrokCLIBackend(runner)
    if name == "deepseek":
        api_key = deepseek_api_key if deepseek_api_key is not None else _default_deepseek_key()
        if not api_key:
            raise BackendUnavailableError("deepseek api key is empty")
        return DeepSeekCLIBackend(runner, api_key)
    return ClaudeCLIBackend(runner)


def complete_text(backend: Backend, req: CompletionRequest) -> str:
    """`llm_text`: collapse codex's occasional double emit."""
    return collapse_doubled_text(backend.complete(req))


def complete_json(backend: Backend, req: CompletionRequest) -> str | None:
    """`llm_json`: extract from the RAW body, with no collapse pass.

    The asymmetry with `complete_text` is deliberate and matches `llm.sh`.
    """
    return extract_json_object(backend.complete(req))

"""Ref-counted start/stop of the embedder daemon, delegated to Bash.

`embedder-guard.sh` stays the single implementation because it owns the
refcount directory that the parallel cycle-one.sh processes share; a second
implementation in Python would race against it (spec §3.2). This is a thin
wrapper, not a reimplementation.

`Runner.run` (see `llm/runner.py`) returns a plain string, never a return
code -- `SubprocessRunner` signals a failed or timed-out subprocess by
returning `""`. `embedder-guard.sh` itself always exits 0 for `up`/`down`
(its own comment: "a guard must never abort its caller"), so there is no
exit-code signal to plumb through even in principle. `up()` and `down()`
both therefore stay silent on an empty/failed result -- raising here would
turn best-effort daemon plumbing into a reason to abort an act/dream round,
exactly the failure mode the Bash script was written to avoid. `status()`
has no such caller-abort risk, so it just returns the stripped text.
"""

from __future__ import annotations

from pathlib import Path

from swil_agent.llm.runner import Runner

# `embedder-guard.sh` self-bounds a cold boot at its own START_TIMEOUT
# (`EMBEDDER_START_TIMEOUT`, default 150s -- "cold MPS model load can be
# slow", embedder-guard.sh:30) before a caller can additionally lose up to
# 300s waiting out the script's own mkdir spinlock steal window
# (embedder-guard.sh:48-56, `_lock`'s `age > 300` steal check). So ~450s is
# the legitimate worst case for a healthy `up`/`down` to finish; 480 is that
# plus margin.
#
# This is a backstop against a genuinely WEDGED process, not a policy knob
# to tune down for a snappier round: `SubprocessRunner` enforces its timeout
# by killing the child's process group (see `llm/runner.py`), and `cmd_up`/`cmd_down` hold
# an mkdir spinlock (`_lock`/`_unlock`) for their entire body. A SIGKILL
# mid-critical-section never runs `rmdir "$LOCKDIR"`, so it wedges every
# other `up`/`down` call in a parallel round for up to that same 300s steal
# window, AND drops the refcount increment/decrement that call was making --
# meanwhile the daemon itself, started via `nohup`, likely survives the kill
# undisowned, so nobody's bookkeeping reflects a process that is still
# running. Lowering this constant reintroduces a race that does not exist in
# the Bash runtime today: `cycle-one.sh:23` is `bash "$GUARD" up || true`
# with NO timeout at all -- the port must not make cold boots less reliable
# than the script it's wrapping. Do not lower it without re-deriving the
# worst-case arithmetic above against the live script's values.
DEFAULT_TIMEOUT = 480.0

# Since 2026-10-15 `SubprocessRunner` starts every child in its own session,
# so `embedder-guard.sh up` (and the daemon it `nohup`s) is no longer in the
# worker's process group: a per-account round kill (`kill -TERM -<pgid>`)
# no longer takes down the embedder the other accounts share.


class EmbedderGuard:
    def __init__(
        self, agent_root: Path, *, runner: Runner, timeout: float = DEFAULT_TIMEOUT
    ) -> None:
        self._script = str(agent_root / "scripts" / "embedder-guard.sh")
        self._runner = runner
        self._timeout = timeout

    def _run(self, verb: str) -> str:
        return self._runner.run(
            ["bash", self._script, verb], stdin=None, env=None, timeout=self._timeout
        )

    def up(self) -> None:
        self._run("up")

    def down(self) -> None:
        self._run("down")

    def status(self) -> str:
        return self._run("status").strip()

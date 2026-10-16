"""Shell scripts under `agent/scripts/`: syntax and the Era 3 roster rule."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
RETIRED = (
    "auto-run.sh",
    "dream.sh",
    "heartbeat.sh",
    "rotate-memory.sh",
    "rule-check.sh",
    "behavior-snapshot.sh",
    "snapshot.sh",
    "population-metric.sh",
    "agent-summary.sh",
    "backfill-behavior.sh",
    "backfill-rule-check.sh",
    "backfill-snapshots.sh",
    "setup-humans.sh",
    "setup-agents.sh",
    "swil.sh",
    # The Persona Bench, ported to `swil-agent bench` in S3 (`bench/`).
    "llm.sh",
    "deepseek-env.sh",
    "benchmark-run.sh",
    "benchmark-all.sh",
    "llm-smoke.sh",
)


def _shell_scripts() -> list[Path]:
    return sorted(p for p in SCRIPTS.rglob("*.sh") if ".venv" not in p.parts)


@pytest.mark.parametrize("script", _shell_scripts(), ids=lambda p: str(p.relative_to(SCRIPTS)))
def test_every_shell_script_parses(script: Path) -> None:
    result = subprocess.run(["bash", "-n", str(script)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_the_retired_bash_runtime_is_gone() -> None:
    assert [name for name in RETIRED if (SCRIPTS / name).exists()] == []


def _agent_tree(tmp_path: Path) -> Path:
    """A copy of the scripts dir under a throwaway `agent/` with a mixed roster."""
    root = tmp_path / "agent"
    root.mkdir()
    (root / "scripts").symlink_to(SCRIPTS)
    for name, body in {
        "era3": "---\nusername: era3\nera: 3\n---\n# x\n",
        "era3crlf": "---\r\nusername: era3crlf\r\nera: 3\r\n---\r\n# x\r\n",
        "era2": "# x\n\n- **Username:** era2\n",
        "era30": "---\nera: 30\n---\n# x\n",
    }.items():
        (root / "agents" / name).mkdir(parents=True)
        (root / "agents" / name / "personality.md").write_bytes(body.encode())
    (root / "agents" / "empty").mkdir()
    (root / "humans" / "h").mkdir(parents=True)
    (root / "humans" / "h" / "personality.md").write_text("---\nera: 3\n---\n", encoding="utf-8")
    return root


def test_status_counts_only_era_3_agents(tmp_path: Path) -> None:
    root = _agent_tree(tmp_path)
    result = subprocess.run(
        ["bash", str(root / "scripts" / "opportunistic-round.sh"), "--status"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert "roster     : 2 runnable account(s)" in result.stdout


_COMMIT_SECTION = "# ── 9. commit the round's output"
_ARCHIVE_GUARD = "git ls-files --error-unmatch agent/archive/era-2/boundary.json"
_SKIP_LINE = 'log "auto-commit skipped: Era 2 archive not committed yet"'


def test_auto_commit_is_guarded_by_the_committed_era_2_archive() -> None:
    """`git add agent/agents` must never run before the archive is tracked,
    or history records the Era 2 roster as deleted."""
    text = (SCRIPTS / "opportunistic-round.sh").read_text(encoding="utf-8")
    section = text[text.index(_COMMIT_SECTION) :]
    assert _ARCHIVE_GUARD in section
    assert _SKIP_LINE in section
    assert section.index(_ARCHIVE_GUARD) < section.index("\n    git add agent/agents\n")


def test_auto_commit_skips_and_stages_nothing_while_the_archive_is_untracked(
    tmp_path: Path,
) -> None:
    text = (SCRIPTS / "opportunistic-round.sh").read_text(encoding="utf-8")
    section = text[text.index(_COMMIT_SECTION) :]
    repo = tmp_path / "repo"
    (repo / "agent" / "agents" / "a").mkdir(parents=True)
    (repo / "agent" / "agents" / "a" / "memory.md").write_text("x\n", encoding="utf-8")
    (repo / "agent" / "archive" / "era-2").mkdir(parents=True)
    (repo / "agent" / "archive" / "era-2" / "boundary.json").write_text("{}\n", encoding="utf-8")
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    prelude = 'log() { echo "$*"; }\nAUTO_COMMIT=1\nok=1; bad=0; timedout=0\n'
    result = subprocess.run(
        ["bash", "-c", prelude + section],
        capture_output=True,
        text=True,
        timeout=30,
        env={"REPO_DIR": str(repo), "PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"},
    )
    assert result.returncode == 0, result.stderr
    assert "auto-commit skipped: Era 2 archive not committed yet" in result.stdout
    staged = subprocess.run(
        ["git", "-C", str(repo), "diff", "--cached", "--name-only"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert staged.stdout == ""


# ── prune-checkpoints.py: keeps the NEWEST rounds per account ──────────────


def _checkpoint_db(path: Path, threads: list[str]) -> None:
    import sqlite3

    con = sqlite3.connect(path)
    con.execute("CREATE TABLE checkpoints (thread_id TEXT)")
    con.execute("CREATE TABLE writes (thread_id TEXT)")
    con.executemany("INSERT INTO checkpoints VALUES (?)", [(t,) for t in threads])
    con.executemany("INSERT INTO writes VALUES (?)", [(t,) for t in threads])
    con.commit()
    con.close()


def _remaining(path: Path) -> list[str]:
    import sqlite3

    con = sqlite3.connect(path)
    try:
        return sorted(r[0] for r in con.execute("SELECT DISTINCT thread_id FROM checkpoints"))
    finally:
        con.close()


def test_prune_keeps_the_newest_of_mixed_sweep_manual_and_era_2_rounds(tmp_path: Path) -> None:
    """S2 ids lead with the UTC stamp, so `-r`/`-m` order by time; Era 2's
    suffixless keys rank below every S2 id, so they are pruned first even
    when their stamp is later."""
    db = tmp_path / "cycle.sqlite"
    _checkpoint_db(
        db,
        [
            "builtin:zenith:20991231T235959",
            "builtin:zenith:20261014T091500Z-r",
            "builtin:zenith:20261016T080000Z-m",
            "builtin:zenith:20261015T120000Z-r",
            "builtin:other:20261001T000000Z-r",
        ],
    )
    result = subprocess.run(
        ["python3", str(SCRIPTS / "prune-checkpoints.py"), "--db", str(db), "--keep", "2"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert _remaining(db) == [
        "builtin:other:20261001T000000Z-r",
        "builtin:zenith:20261015T120000Z-r",
        "builtin:zenith:20261016T080000Z-m",
    ]


def test_prunes_copy_of_the_round_id_regex_matches_the_package() -> None:
    from swil_agent.round_id import ROUND_ID_RE

    text = (SCRIPTS / "prune-checkpoints.py").read_text(encoding="utf-8")
    assert f'ROUND_ID_RE = re.compile(r"{ROUND_ID_RE.pattern}", re.ASCII)' in text


def test_prunes_regex_rejects_arabic_indic_digits() -> None:
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "prune_checkpoints", SCRIPTS / "prune-checkpoints.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    arabic = (
        "\u0662\u0660\u0662\u0666\u0661\u0660\u0661\u0664T\u0660\u0669\u0661\u0665\u0660\u0660Z-r"
    )
    assert module.ROUND_ID_RE.fullmatch(arabic) is None
    assert module.ROUND_ID_RE.fullmatch("20261014T091500Z-r") is not None


# ── opportunistic-round.sh: one round id per sweep, shuffled order ─────────

_ROUND_HELPERS_START = "# ── round id and sweep order"
_ROUND_HELPERS_END = "# ── 1. interval gate"
_EXPORT_LINE = 'export SWIL_ROUND_ID="$(date -u +%Y%m%dT%H%M%SZ)-r"'


def _round_helpers() -> str:
    text = (SCRIPTS / "opportunistic-round.sh").read_text(encoding="utf-8")
    return text[text.index(_ROUND_HELPERS_START) : text.index(_ROUND_HELPERS_END)]


def _bash(snippet: str) -> str:
    result = subprocess.run(
        ["bash", "-c", _round_helpers() + snippet],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    return result.stdout


_NAMES = [f"a{i:02d}" for i in range(20)]


def test_the_sweep_exports_one_round_id_before_any_worker_starts() -> None:
    text = (SCRIPTS / "opportunistic-round.sh").read_text(encoding="utf-8")
    assert text.count("export SWIL_ROUND_ID=") == 1
    assert _EXPORT_LINE in text
    # Minted before the first worker is launched, and the order is logged.
    assert text.index(_EXPORT_LINE) < text.index('run_one "$name" &')
    assert 'log "round $SWIL_ROUND_ID' in text


def test_the_seed_is_derived_from_the_round_id() -> None:
    first = _bash('round_seed "20261014T091500Z-r"').strip()
    again = _bash('round_seed "20261014T091500Z-r"').strip()
    other = _bash('round_seed "20261016T091500Z-r"').strip()
    assert first.isdigit()
    assert first == again
    assert first != other


def test_the_shuffle_is_a_deterministic_permutation_per_seed() -> None:
    import random

    names = " ".join(_NAMES)
    first = _bash(f"shuffle_roster 12345 {names}").split()
    again = _bash(f"shuffle_roster 12345 {names}").split()
    other = _bash(f"shuffle_roster 54321 {names}").split()

    assert sorted(first) == _NAMES
    assert first == again
    assert first != other
    assert first != _NAMES
    # Reproducible from the logged seed alone, outside the script.
    expected = sorted(_NAMES)
    random.Random(12345).shuffle(expected)
    assert first == expected


def test_the_shuffle_ignores_input_order() -> None:
    forward = _bash(f"shuffle_roster 7 {' '.join(_NAMES)}").split()
    backward = _bash(f"shuffle_roster 7 {' '.join(reversed(_NAMES))}").split()
    assert forward == backward


def test_the_embedder_down_warning_names_era_3_consequences() -> None:
    """Era 3 has no drift gate. With the embedder down the duplicate guard
    fails open and post vectors go unfiled -- the log line says so and names
    the recovery command."""
    text = (SCRIPTS / "opportunistic-round.sh").read_text(encoding="utf-8")
    assert "drift gate" not in text
    assert (
        'log "WARN embedder would not start — the duplicate guard fails open and post '
        "vectors will be missing this round; recover them afterwards with: "
        'uv run --project agent swil-agent backfill-post-vectors"'
    ) in text
    # No backticks inside that double-quoted string: bash would RUN them.
    line = next(x for x in text.splitlines() if "embedder would not start" in x)
    assert "`" not in line


# ── shell entry points name real CLI commands and flags ────────────────────

_INVOCATION_RE = re.compile(r"swil-agent((?:[ \t]+[^\s|&;>]+)+)")


def _cli_tokens(text: str) -> list[tuple[str, list[str]]]:
    """(command, flags) for every `swil-agent <command> … --flag` in script text.

    Comment lines and prose mentions are skipped: only lines whose first
    word is `exec` / `uv` / `swil-agent` count as invocations.
    """
    found: list[tuple[str, list[str]]] = []
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("#") or not re.match(r"(exec\s+)?(uv\s+run\b|swil-agent\b)", line):
            continue
        for match in _INVOCATION_RE.finditer(line):
            words = match.group(1).split()
            command = next((w for w in words if not w.startswith("-")), None)
            if command is None:
                continue
            found.append((command, [w for w in words if w.startswith("--")]))
    return found


def _unknown_cli_names(text: str) -> list[str]:
    import typer.main

    from swil_agent import cli

    root = typer.main.get_command(cli.app)
    commands = getattr(root, "commands", {})
    bad: list[str] = []
    for command, flags in _cli_tokens(text):
        sub = commands.get(command)
        if sub is None:
            bad.append(command)
            continue
        known = {opt for param in sub.params for opt in (*param.opts, *param.secondary_opts)}
        bad.extend(flag for flag in flags if flag not in known)
    return bad


@pytest.mark.parametrize("name", ["cycle-one.sh", "opportunistic-round.sh"])
def test_shell_entry_points_name_real_cli_commands_and_flags(name: str) -> None:
    text = (SCRIPTS / name).read_text(encoding="utf-8")
    assert _unknown_cli_names(text) == []


def test_cycle_one_actually_invokes_cycle_with_auto() -> None:
    text = (SCRIPTS / "cycle-one.sh").read_text(encoding="utf-8")
    assert ("cycle", ["--auto"]) in _cli_tokens(text)


def test_cli_name_check_rejects_a_bogus_command_or_flag() -> None:
    assert _unknown_cli_names("exec uv run --project x swil-agent cycl NAME --auto") == ["cycl"]
    assert _unknown_cli_names("exec uv run --project x swil-agent cycle NAME --bogus") == [
        "--bogus"
    ]


# ── opportunistic-round.sh, run end to end against stub workers ─────────────
#
# The real script, copied into a throwaway `agent/` beside a STUB
# `cycle-one.sh`, so no `uv`/`swil-agent` ever starts. `curl`, `claude`, `uv`
# and `caffeinate` are stubs on PATH: no request leaves the machine (`SWIL_URL`
# names a closed local port and `curl` never runs), and `AUTO_COMMIT=0` keeps
# git out of it. `/bin/bash` is the shell launchd runs it with (3.2 on macOS).

_STUB_CYCLE = """#!/bin/bash
# Stub worker. Records its pid, its process group and a grandchild, then
# behaves as STUB_MODE says: `term` exits 143 on TERM (the real CLI's
# SystemExit(143)); `deaf` ignores TERM, and so does its grandchild.
name="$1"
out="$STUB_OUT/$name"
# Traps first: `.started` is the test's cue to signal, so the stub must
# already be in its final disposition when it appears.
if [[ "$STUB_MODE" == "deaf" ]]; then trap '' TERM; fi
if [[ "$STUB_MODE" == "term" ]]; then
  trap 'echo term > "$out.term"; exit 143' TERM
fi
sleep 600 &
echo "$$ $(ps -o pgid= -p $$ | tr -d ' ') $!" > "$out.started"
while :; do sleep 1; done
"""

# A stand-in for `embedder-guard.sh`: records each call, starts nothing.
_STUB_GUARD = '#!/bin/bash\necho "$1" >> "$STUB_OUT/guard.log"\n'

_STUBS = {
    # Every probe answers 200, except the embedder's when the test points
    # EMBEDDER_URL at `embedder.down` -- then the round starts it via the guard.
    "curl": '#!/bin/sh\ncase "$*" in *embedder.down*) exit 7 ;; esac\nprintf 200\nexit 0\n',
    "claude": "#!/bin/sh\nexit 0\n",
    "uv": "#!/bin/sh\nexit 0\n",
    "caffeinate": '#!/bin/sh\nshift\nexec "$@"\n',
}


def _round_tree(tmp_path: Path, names: list[str]) -> tuple[Path, dict[str, str]]:
    root = tmp_path / "agent"
    (root / "scripts").mkdir(parents=True)
    script = root / "scripts" / "opportunistic-round.sh"
    script.write_bytes((SCRIPTS / "opportunistic-round.sh").read_bytes())
    (root / "scripts" / "cycle-one.sh").write_text(_STUB_CYCLE, encoding="utf-8")
    (root / "scripts" / "embedder-guard.sh").write_text(_STUB_GUARD, encoding="utf-8")
    for name in names:
        (root / "agents" / name).mkdir(parents=True)
        (root / "agents" / name / "personality.md").write_text(
            f"---\nusername: {name}\nera: 3\n---\n# x\n", encoding="utf-8"
        )
    (root / ".env").write_text("SWIL_URL=http://127.0.0.1:9\n", encoding="utf-8")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for tool, body in _STUBS.items():
        (bin_dir / tool).write_text(body, encoding="utf-8")
        (bin_dir / tool).chmod(0o755)
    out = tmp_path / "out"
    out.mkdir()
    env = {
        "PATH": f"{bin_dir}:/usr/bin:/bin",
        "HOME": str(tmp_path),
        "STUB_OUT": str(out),
        "STUB_MODE": "term",
        "ALLOW_BATTERY": "1",
        "AUTO_COMMIT": "0",
        "CHECKPOINT_KEEP": "0",
        "NET_WAIT_SECS": "0",
        "EMBEDDER_URL": "http://127.0.0.1:9",
        "ACCOUNT_TIMEOUT": "60",
        "ACCOUNT_KILL_GRACE": "3",
        "PARALLEL": "5",
    }
    return root, env


def _started(tmp_path: Path, name: str) -> tuple[int, int, int] | None:
    marker = tmp_path / "out" / f"{name}.started"
    if not marker.exists():
        return None
    pid, pgid, grandchild = (int(x) for x in marker.read_text(encoding="utf-8").split())
    return pid, pgid, grandchild


def _alive(pid: int) -> bool:
    import os

    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    # A zombie still answers kill(0): ask ps whether it is one.
    state = subprocess.run(
        ["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True
    ).stdout.strip()
    return bool(state) and not state.startswith("Z")


def _wait_for(predicate: object, timeout: float = 20.0) -> bool:
    import time

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():  # type: ignore[operator]
            return True
        time.sleep(0.1)
    return False


def _round_log(root: Path) -> str:
    return (root / "logs" / "opportunistic.log").read_text(encoding="utf-8")


def _reap(tmp_path: Path, names: list[str]) -> None:
    """Never leave a stub behind, whatever the assertion said."""
    import contextlib
    import os
    import signal

    for name in names:
        started = _started(tmp_path, name)
        if started is None:
            continue
        for pid in started:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.kill(pid, signal.SIGKILL)


@pytest.mark.parametrize("mode", ["term", "deaf"])
def test_a_timed_out_worker_loses_its_whole_group_and_counts_as_a_timeout(
    tmp_path: Path, mode: str
) -> None:
    """F3. The worker runs in its own session, so `kill -- -$pgid` reaches it
    and its grandchild; `term` exits on the TERM, `deaf` (TERM ignored by the
    worker AND its grandchild) needs the KILL after the grace. Either way
    `run_one` returns 124 and the summary counts a timeout, not a failure."""
    names = ["solo"]
    root, env = _round_tree(tmp_path, names)
    env |= {"ACCOUNT_TIMEOUT": "1", "ACCOUNT_KILL_GRACE": "2", "STUB_MODE": mode}
    try:
        result = subprocess.run(
            ["/bin/bash", str(root / "scripts" / "opportunistic-round.sh"), "--force"],
            capture_output=True,
            text=True,
            timeout=60,
            env=env,
        )
        started = _started(tmp_path, "solo")
        assert result.returncode == 0, result.stderr
        assert started is not None
        pid, pgid, grandchild = started
        assert pgid == pid, "the worker must lead its own process group"
        log = _round_log(root)
        assert "round done — ok=0 failed=0 timeout=1" in log, log
        assert "rc=143" not in log
        assert ("still alive" in log) is (mode == "deaf"), log
        assert (tmp_path / "out" / "solo.term").exists() is (mode == "term")
        assert _wait_for(lambda: not _alive(pid) and not _alive(grandchild), 5)
        assert not (root / ".agent-state" / "round.lock").exists()
    finally:
        _reap(tmp_path, names)


def test_sigterm_ends_the_round_forwards_term_and_starts_no_further_batch(
    tmp_path: Path,
) -> None:
    """F7. A TERM during batch 1 stops batch 1's workers (forwarded to their
    groups -- launchd's own signal cannot reach another session), removes
    the round lock and exits 143. Batch 2 never starts."""
    import signal

    names = ["one", "two"]
    root, env = _round_tree(tmp_path, names)
    env |= {"PARALLEL": "1"}
    proc = subprocess.Popen(
        ["/bin/bash", str(root / "scripts" / "opportunistic-round.sh"), "--force"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    try:
        assert _wait_for(lambda: any(_started(tmp_path, n) for n in names))
        [first] = [n for n in names if _started(tmp_path, n)]
        pid, _, grandchild = _started(tmp_path, first)  # type: ignore[misc]
        proc.send_signal(signal.SIGTERM)
        _, stderr = proc.communicate(timeout=30)
        assert proc.returncode == 143, stderr
        assert (tmp_path / "out" / f"{first}.term").exists()
        assert [n for n in names if _started(tmp_path, n)] == [first]
        assert _wait_for(lambda: not _alive(pid) and not _alive(grandchild), 5)
        assert not (root / ".agent-state" / "round.lock").exists()
        log = _round_log(root)
        assert "round interrupted by SIGTERM" in log, log
        assert "round done" not in log
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.communicate()
        _reap(tmp_path, names)


def test_a_signalled_round_still_stops_the_embedder_it_started(tmp_path: Path) -> None:
    """The signal path does section 8's teardown too: an embedder this round
    started (`owns_embedder=1`) gets its `down`, and the stopped worker's
    lock file is swept."""
    import signal

    names = ["one"]
    root, env = _round_tree(tmp_path, names)
    env |= {"EMBEDDER_URL": "http://embedder.down"}
    stale = root / ".agent-state" / "lock_one"
    proc = subprocess.Popen(
        ["/bin/bash", str(root / "scripts" / "opportunistic-round.sh"), "--force"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    try:
        assert _wait_for(lambda: _started(tmp_path, "one") is not None)
        pid, _, _ = _started(tmp_path, "one")  # type: ignore[misc]
        stale.write_text(f"{pid}\n", encoding="utf-8")  # as the worker's lease would
        proc.send_signal(signal.SIGTERM)
        proc.communicate(timeout=30)
        assert proc.returncode == 143
        guard = (tmp_path / "out" / "guard.log").read_text(encoding="utf-8").split()
        assert guard == ["up", "down"]
        assert "embedder stopped" in _round_log(root)
        assert not stale.exists()
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.communicate()
        _reap(tmp_path, names)


def test_sigint_exits_130(tmp_path: Path) -> None:
    import signal

    names = ["one"]
    root, env = _round_tree(tmp_path, names)
    proc = subprocess.Popen(
        ["/bin/bash", str(root / "scripts" / "opportunistic-round.sh"), "--force"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    try:
        assert _wait_for(lambda: _started(tmp_path, "one") is not None)
        proc.send_signal(signal.SIGINT)
        proc.communicate(timeout=30)
        assert proc.returncode == 130
        assert not (root / ".agent-state" / "round.lock").exists()
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.communicate()
        _reap(tmp_path, names)


def test_the_default_account_timeout_is_derived_not_900() -> None:
    text = (SCRIPTS / "opportunistic-round.sh").read_text(encoding="utf-8")
    assert text.count('ACCOUNT_TIMEOUT="${ACCOUNT_TIMEOUT:-1800}"') == 2
    assert ":-900}" not in text
    # Job control would make each `run_one` subshell a group leader, and the
    # perl `setsid` of its worker would then fail (EPERM).
    assert "set -m" not in [line.strip() for line in text.splitlines()]


def test_auto_commit_commits_only_agent_agents_never_the_owners_index(tmp_path: Path) -> None:
    """F6. The owner had something unrelated staged; the unattended,
    --no-verify commit must leave it staged and out of HEAD."""
    text = (SCRIPTS / "opportunistic-round.sh").read_text(encoding="utf-8")
    section = text[text.index(_COMMIT_SECTION) :]
    repo = tmp_path / "repo"
    (repo / "agent" / "agents" / "a").mkdir(parents=True)
    (repo / "agent" / "archive" / "era-2").mkdir(parents=True)
    (repo / "agent" / "archive" / "era-2" / "boundary.json").write_text("{}\n", encoding="utf-8")
    env = {
        "REPO_DIR": str(repo),
        "PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
        "HOME": str(tmp_path),
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_AUTHOR_NAME": "t",
        "GIT_AUTHOR_EMAIL": "t@example.test",
        "GIT_COMMITTER_NAME": "t",
        "GIT_COMMITTER_EMAIL": "t@example.test",
    }

    def git(*args: str) -> str:
        return subprocess.run(
            ["git", "-C", str(repo), *args], capture_output=True, text=True, check=True, env=env
        ).stdout

    git("init", "-q")
    git("add", "agent/archive/era-2/boundary.json")
    git("commit", "-q", "-m", "chore: seed")
    (repo / "agent" / "agents" / "a" / "memory.md").write_text("x\n", encoding="utf-8")
    (repo / "unrelated.txt").write_text("owner's half-done change\n", encoding="utf-8")
    git("add", "unrelated.txt")

    prelude = 'log() { echo "$*"; }\nAUTO_COMMIT=1\nok=1; bad=0; timedout=0\n'
    result = subprocess.run(
        ["/bin/bash", "-c", prelude + section],
        capture_output=True,
        text=True,
        timeout=30,
        env=env,
    )
    assert result.returncode == 0, result.stderr
    assert "committed round output (not pushed)" in result.stdout
    assert git("show", "--name-only", "--format=", "HEAD").split() == ["agent/agents/a/memory.md"]
    assert git("diff", "--cached", "--name-only").split() == ["unrelated.txt"]

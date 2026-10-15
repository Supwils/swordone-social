"""`doctor`'s probes, below the CLI (`swil_agent/doctor.py`, S3 §6).

The command tests in `test_cli.py` replace these one at a time; this drives
the ones that touch the machine against fakes of `shutil.which` and
`subprocess.run`.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from swil_agent import doctor


def test_heartbeat_status_without_launchctl_is_not_a_fail(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(doctor.shutil, "which", lambda name: None)
    assert doctor.heartbeat_launchctl_status() == "launchctl missing (not a fail)"


@pytest.mark.parametrize(
    ("returncode", "expected"),
    [
        (0, "loaded (superseded — do not load; opportunistic-round.sh is the record)"),
        (113, "not loaded"),
    ],
)
def test_heartbeat_status_reads_launchctl_list(
    monkeypatch: pytest.MonkeyPatch, returncode: int, expected: str
) -> None:
    calls: list[list[str]] = []

    def run(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        calls.append(argv)
        return subprocess.CompletedProcess(argv, returncode, "", "")

    monkeypatch.setattr(doctor.shutil, "which", lambda name: "/bin/launchctl")
    monkeypatch.setattr(doctor.subprocess, "run", run)
    assert doctor.heartbeat_launchctl_status() == expected
    assert calls == [["/bin/launchctl", "list", doctor.HEARTBEAT_LABEL]]


def test_heartbeat_status_survives_a_launchctl_that_hangs(monkeypatch: pytest.MonkeyPatch) -> None:
    def run(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        raise subprocess.TimeoutExpired(argv, 5)

    monkeypatch.setattr(doctor.shutil, "which", lambda name: "/bin/launchctl")
    monkeypatch.setattr(doctor.subprocess, "run", run)
    assert doctor.heartbeat_launchctl_status() == "launchctl missing (not a fail)"


def test_the_lock_dir_probe_reports_an_unwritable_dir(tmp_path: Path) -> None:
    ok, message = doctor.lock_dir_writable(tmp_path)
    assert ok
    assert message == f"writable ({tmp_path / '.agent-state'})"
    assert not (tmp_path / ".agent-state" / ".doctor-write-probe").exists()

    blocked = tmp_path / "blocked"
    blocked.write_text("a file where the directory should be", encoding="utf-8")
    ok, message = doctor.lock_dir_writable(blocked)
    assert not ok
    assert message.startswith(f"not writable ({blocked / '.agent-state'}: ")


def test_on_path_asks_shutil_which(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(doctor.shutil, "which", lambda name: "/x" if name == "uv" else None)
    assert doctor.on_path("uv")
    assert not doctor.on_path("claude")

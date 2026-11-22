"""The probes behind `swil-agent doctor` (spec §11), and the local roster.

Each probe answers one readiness question and reports it as data: a bool, a
`(ok, message)` pair or a status string. The command in `cli/ops.py` decides
what to print and whether the machine is ready; nothing here prints except
through the `emit` callable `smoke_arms` is handed, and nothing here exits.

These are the CLI's second seam home (S3 §12.13): `cli/ops.py` calls every
one of them as an attribute of this module, so a test replaces one probe
with `monkeypatch.setattr(doctor, "<name>", fake)` and the command picks the
fake up at call time.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Final

import httpx

from swil_agent.analysis.population_metric import ACCOUNTS_DIR
from swil_agent.config import Settings
from swil_agent.llm.backends.grok import GROK_AUDITED_VERSION
from swil_agent.llm.protocol import Backend
from swil_agent.llm.runner import CompletionRequest
from swil_agent.models import Persona
from swil_agent.persona.format import PersonaFormatError
from swil_agent.persona.loader import load_persona

HEARTBEAT_LABEL: Final = "com.swil.heartbeat"

_HTTP_TIMEOUT = 10.0

_SINCE_FUTURE: Final = "2999-01-01T00:00:00Z"
_SMOKE_PROMPT: Final = "回复 ok"

# The CLI each Era 3 backend shells out to (`llm/backends/`).
_BACKEND_BINARIES: Final = {
    "claude": "claude",
    "codex": "codex",
    "grok": "grok",
    "cursor": "cursor-agent",
}


def on_path(name: str) -> bool:
    return shutil.which(name) is not None


def heartbeat_launchctl_status() -> str:
    """Best-effort: missing launchctl is not a doctor failure (spec §11)."""
    launchctl = shutil.which("launchctl")
    if launchctl is None:
        return "launchctl missing (not a fail)"
    try:
        completed = subprocess.run(
            [launchctl, "list", HEARTBEAT_LABEL],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "launchctl missing (not a fail)"
    if completed.returncode == 0:
        return "loaded (superseded — do not load; opportunistic-round.sh is the record)"
    return "not loaded"


def lock_dir_writable(agent_root: Path) -> tuple[bool, str]:
    lock_dir = agent_root / ".agent-state"
    probe = lock_dir / ".doctor-write-probe"
    try:
        lock_dir.mkdir(parents=True, exist_ok=True)
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
    except OSError as exc:
        return False, f"not writable ({lock_dir}: {exc})"
    return True, f"writable ({lock_dir})"


def roster_names(agent_root: Path) -> list[str]:
    """Every account directory with a `personality.md`, sorted."""
    root = agent_root / ACCOUNTS_DIR
    if not root.is_dir():
        return []
    return sorted(
        child.name
        for child in root.iterdir()
        if child.is_dir() and (child / "personality.md").is_file()
    )


def roster_count(agent_root: Path) -> int:
    return len(roster_names(agent_root))


def since_probe(
    settings: Settings, *, transport: httpx.BaseTransport | None = None
) -> tuple[bool, str]:
    """A server that ignores `since` returns posts for a date in 2999.

    Unauthenticated: `/feed/global` is a public read.
    """
    try:
        with httpx.Client(transport=transport, timeout=_HTTP_TIMEOUT) as client:
            response = client.get(
                f"{settings.swil_url}/api/v1/feed/global",
                params={"since": _SINCE_FUTURE, "limit": 1},
            )
    except httpx.HTTPError as exc:
        return False, f"unreachable ({exc})"
    if response.status_code != 200:
        return False, f"HTTP {response.status_code}"
    try:
        items = response.json()["data"]["items"]
    except (ValueError, KeyError, TypeError):
        return False, "unexpected response shape"
    if items:
        return False, "server ignores `since` -- deploy the backend first"
    return True, "ok"


def era3_arms(agent_root: Path) -> dict[str, Persona]:
    """One persona per distinct `backend:model` among valid Era 3 files."""
    arms: dict[str, Persona] = {}
    for path in sorted((agent_root / "agents").glob("*/personality.md")):
        try:
            persona = load_persona(path.parent)
        except (PersonaFormatError, OSError):
            continue
        label = f"{persona.backend}:{persona.model}" if persona.model else persona.backend
        arms.setdefault(label, persona)
    return arms


def doctor_binaries(agent_root: Path) -> list[str]:
    """`claude` and `uv`, then each roster backend's CLI, deduplicated."""
    binaries = ["claude", "uv"]
    for persona in era3_arms(agent_root).values():
        binary = _BACKEND_BINARIES.get(persona.backend)
        if binary is not None and binary not in binaries:
            binaries.append(binary)
    return binaries


def smoke_arms(
    settings: Settings,
    *,
    backend_for: Callable[[Persona, Settings], Backend],
    emit: Callable[[str], object],
) -> bool:
    """Send one tiny prompt through each distinct arm; True when all pass.

    `backend_for` is the CLI's backend builder (`cli/compose.py`), passed in
    so this module stays below the composition root and a test that fakes
    the builder there fakes it here too. `emit` prints one line.
    """
    arms = era3_arms(settings.agent_root)
    if not arms:
        emit("smoke: no Era 3 accounts")
        return True
    ok = True
    for label, persona in arms.items():
        reason = smoke_one(persona, settings, backend_for)
        if reason is None:
            emit(f"smoke {label}: OK")
        else:
            emit(f"smoke {label}: FAIL ({reason})")
            ok = False
    return ok


def smoke_one(
    persona: Persona,
    settings: Settings,
    backend_for: Callable[[Persona, Settings], Backend],
) -> str | None:
    """One tiny prompt through `persona`'s arm: `None` when it answered, the
    failure's reason otherwise."""
    try:
        reply = backend_for(persona, settings).complete(
            CompletionRequest(system="", user=_SMOKE_PROMPT, model=persona.model)
        )
    except Exception as exc:  # any backend failure is a failed arm
        return str(exc) or type(exc).__name__
    return None if reply.strip() else "empty reply"


def preflight_arms(
    settings: Settings,
    *,
    backend_for: Callable[[Persona, Settings], Backend],
) -> dict[str, str | None]:
    """Every distinct Era 3 arm, probed one after another: label -> `None` (it
    answered) or the reason it did not.

    Sequential on purpose, in the main thread. A signal reaches only the main
    thread: probed from worker threads, a round's TERM (or Ctrl-C) became
    `SystemExit` in a thread blocked on `future.result()` while each CLI kept
    running to its own timeout (up to 600 s on grok), and
    `SubprocessRunner`'s kill-the-group-on-exception never fired, orphaning
    the CLIs. Here it fires. The cost is the sum of the calls instead of the
    slowest one, each still capped by its backend's timeout.

    A grok arm on a version other than the audited one fails WITHOUT a call --
    its tool denylist is only known to be complete for that version, and grok
    has upgraded itself despite `auto_update = false` (2026-11-03).
    """
    results: dict[str, str | None] = {}
    for label, persona in era3_arms(settings.agent_root).items():
        if persona.backend == "grok":
            audited, message = grok_audit(grok_version())
            if not audited:
                results[label] = f"grok {message}"
                continue
        results[label] = smoke_one(persona, settings, backend_for)
    return results


def claude_login_expiry() -> datetime | None:
    """When the claude CLI's sign-in ends (`claude auth status` ->
    `loginExpiresAt`), or `None` when it cannot be read.

    A claude.ai sign-in has a hard end that renewing does not move; past it
    both claude arms and the observer note fail. Best-effort, like the
    heartbeat probe: an unreadable status is not a failure."""
    try:
        completed = subprocess.run(
            ["claude", "auth", "status"], capture_output=True, text=True, timeout=15, check=False
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    try:
        raw = json.loads(completed.stdout)["loginExpiresAt"]
        expiry = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except (ValueError, KeyError, TypeError):
        return None
    return expiry if expiry.tzinfo is not None else None


# Rounds run 48 h apart, so a week's notice is at least three rounds' warning.
LOGIN_WARN_DAYS: Final = 7


def login_warning(expiry: datetime | None, now: datetime) -> str | None:
    """The WARN line for a claude sign-in that ends within `LOGIN_WARN_DAYS`
    (or already has), else `None`."""
    if expiry is None:
        return None
    days = (expiry - now).total_seconds() / 86400
    if days >= LOGIN_WARN_DAYS:
        return None
    if days <= 0:
        return f"claude sign-in ENDED {expiry.isoformat()} -- run `claude auth login`"
    return (
        f"claude sign-in ends {expiry.isoformat()} (in {days:.1f} days) -- "
        "run `claude auth login` before then"
    )


_GROK_VERSION: Final = re.compile(r"\bgrok\s+(\d+(?:\.\d+)+)")


def grok_version() -> str | None:
    """`grok --version`'s version number (`grok 1.0.52 (0920c81…)` -> `1.0.52`),
    or `None` when it cannot be read."""
    try:
        completed = subprocess.run(
            ["grok", "--version"], capture_output=True, text=True, timeout=10, check=False
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    match = _GROK_VERSION.search(completed.stdout or "")
    return match.group(1) if match else None


def grok_audit(version: str | None) -> tuple[bool, str]:
    """The grok arm is tool-less only for the audited version: on grok,
    `--tools ""` no longer empties the toolset, and `GROK_DISALLOWED_TOOLS`
    names the built-ins of exactly that version (`llm/backends/grok.py`)."""
    if version == GROK_AUDITED_VERSION:
        return True, f"{version} (audited)"
    found = version or "unreadable"
    return False, (
        f"{found} is not the audited {GROK_AUDITED_VERSION} -- re-audit GROK_DISALLOWED_TOOLS "
        "from the `--output-format streaming-messages-json` init event, then bump "
        "GROK_AUDITED_VERSION"
    )

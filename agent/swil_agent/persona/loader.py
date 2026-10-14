"""Load a v2 `personality.md` into a typed Persona.

The loader is the gate that keeps a sealed (Era 2) or malformed persona out of
every round: anything that is not a valid era-3 file raises
`PersonaFormatError` before an LLM is called.
"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

from swil_agent.models import Persona
from swil_agent.persona.format import (
    PersonaFormatError,
    clamp_recent,
    parse_persona,
    prompt_text,
)
from swil_agent.persona.validators import card_problems, meta_problems, size_problems


def split_model(spec: str) -> tuple[str, str | None]:
    """`claude:claude-opus-5-5` -> ("claude", "claude-opus-5-5"); `codex` -> ("codex", None)."""
    backend, _, model = spec.strip().partition(":")
    return backend.strip(), model.strip() or None


def resolve_agent_dir(agent_root: Path, name: str) -> Path:
    candidate = agent_root / "agents" / name
    if (candidate / "personality.md").is_file():
        return candidate
    raise FileNotFoundError(f"no personality.md for account {name!r} under {agent_root}/agents")


def load_persona(directory: Path) -> Persona:
    path = directory / "personality.md"
    data = path.read_bytes()
    try:
        raw = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise PersonaFormatError(f"{path} is not valid UTF-8: {exc}") from exc

    problems = size_problems(len(data))
    doc = parse_persona(raw)
    problems += meta_problems(doc.meta) + card_problems(doc.card)
    if problems:
        raise PersonaFormatError(f"{path}: " + "; ".join(problems))

    meta = doc.meta
    username = meta["username"].strip()
    if directory.name != username:
        raise PersonaFormatError(
            f"{path}: directory name {directory.name!r} does not match username {username!r}"
        )

    # An over-limit 最近 (a hand edit) is clamped rather than rejected.
    doc = replace(doc, recent=clamp_recent(doc.recent))
    backend, model = split_model(meta["model"])
    bio = meta.get("bio")
    return Persona(
        username=username,
        display_name=meta["display_name"].strip(),
        bio=(bio.strip() or None) if isinstance(bio, str) else None,
        topics=[topic.strip() for topic in meta["topics"]],
        backend=backend,
        declared_backend=backend,
        model=model,
        board=meta["board"].strip(),
        era=meta["era"],
        card=doc.card,
        recent=list(doc.recent),
        prompt=prompt_text(doc),
        raw=raw,
        directory=directory,
    )

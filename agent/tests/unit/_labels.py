"""The Era 3 roster's model labels, for the no-label-in-a-v2-prompt checks."""

from __future__ import annotations

import re
from pathlib import Path

_AGENTS = Path(__file__).resolve().parents[2] / "agents"
_MODEL = re.compile(r"^model:\s*(\S+)\s*$", re.MULTILINE)


_TOKEN = re.compile(r"[-.]")
# A common English word inside `gemini-3.7-flash-high`, not a model name.
_NOT_A_LABEL = frozenset({"high"})


def roster_model_labels() -> set[str]:
    """Every backend, model id and model family (`claude`, `gpt`, `gemini`,
    `grok`) named by a roster `model:` line, lower-cased, plus every
    alphabetic dash/dot-split token of 4+ characters (`haiku`, `opus`,
    `luna`, `flash`) except `high`."""
    labels: set[str] = set()
    for path in sorted(_AGENTS.glob("*/personality.md")):
        match = _MODEL.search(path.read_text(encoding="utf-8"))
        if match is None:
            continue
        backend, _, model = match.group(1).partition(":")
        labels.update(part.lower() for part in (backend, model, model.split("-")[0]) if part)
        labels.update(
            token.lower()
            for token in _TOKEN.split(model)
            if len(token) >= 4 and token.isalpha() and token.lower() not in _NOT_A_LABEL
        )
    return labels

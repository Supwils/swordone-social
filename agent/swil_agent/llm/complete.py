"""`complete_text` / `complete_json`: the two ways callers consume a backend."""

from __future__ import annotations

from swil_agent.llm.extract import collapse_doubled_text, extract_json_object
from swil_agent.llm.protocol import Backend
from swil_agent.llm.runner import CompletionRequest


def complete_text(backend: Backend, req: CompletionRequest) -> str:
    """`llm_text`: collapse codex's occasional double emit."""
    return collapse_doubled_text(backend.complete(req))


def complete_json(backend: Backend, req: CompletionRequest) -> str | None:
    """`llm_json`: extract from the RAW body, with no collapse pass.

    The asymmetry with `complete_text` is deliberate: `complete_text` collapses a doubled
    body, this does not.
    """
    return extract_json_object(backend.complete(req))

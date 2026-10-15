"""The `Backend` protocol every CLI/API backend satisfies."""

from __future__ import annotations

from typing import Protocol

from swil_agent.llm.runner import CompletionRequest


class Backend(Protocol):
    name: str

    def complete(self, req: CompletionRequest) -> str: ...

"""Wire-format DTOs for the API boundary.

Unlike `models.py` (snake_case, domain-shaped, wire-format-agnostic by
contract — see that module's docstring), types here exist *only* to be
serialized onto the wire and therefore own the snake_case -> camelCase
conversion themselves. They carry no domain meaning of their own; nothing
outside `api/` should ever need to construct or inspect one.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, field_validator


class LabEvent(BaseModel):
    """One row for POST /agents/{username}/events.

    `action`, `reason` and `target_id` are omitted from the wire body when
    empty, and `action` is additionally omitted when it is the placeholder
    "-" (contract 02 §5.3). Emitting
    them as empty strings would change what the /lab surfaces count.

    `occurred_at` is the one field no live-runtime emitter sets: every event
    a round files happens now, and `agent_events.created_at` already defaults
    to now(). It exists for the events that are ABOUT a past moment — a human
    intervention recorded weeks later — because every `/lab` read of that
    table orders and filters by `created_at`, so an event that cannot carry
    its own instant annotates the wrong stretch of the series.
    """

    type: str
    phase: str
    outcome: str
    summary: str
    action: str | None = None
    reason: str | None = None
    target_id: str | None = None
    occurred_at: datetime | None = None
    metrics: dict[str, Any] = Field(default_factory=dict)

    @field_validator("occurred_at")
    @classmethod
    def _must_be_aware(cls, value: datetime | None) -> datetime | None:
        """A naive `occurred_at` is refused rather than guessed at.

        `datetime.isoformat()` on a naive value emits no offset, and zod's
        `z.coerce.date()` hands that to `new Date(...)`, which resolves it in
        the SERVER's timezone. The server runs in UTC and the operator's
        `date` output is local, so a naive value silently lands 7 hours from
        where it belongs — an error of exactly the size that still looks like
        a plausible timestamp. Raising here is safe for every existing
        emitter: none of them sets this field, so this validator cannot fire
        on any fail-soft path.
        """
        if value is not None and value.tzinfo is None:
            raise ValueError("occurred_at must be timezone-aware")
        return value

    def to_wire(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "type": self.type,
            "phase": self.phase,
            "outcome": self.outcome,
            "summary": self.summary,
            "metrics": self.metrics,
        }
        if self.action and self.action != "-":
            body["action"] = self.action
        if self.reason:
            body["reason"] = self.reason
        if self.target_id:
            body["targetId"] = self.target_id
        if self.occurred_at is not None:
            body["occurredAt"] = self.occurred_at.isoformat()
        return body

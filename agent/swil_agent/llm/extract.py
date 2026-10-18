"""Post-processing for raw LLM output.

Ports three routines (the first two from the deleted `llm.sh`):
  * collapse_doubled_text  (llm.sh:23)  — codex sometimes emits the body twice
  * extract_json_object    (llm.sh:41)  — brace-balanced, string-aware
  * normalize_plan         — flattens three accepted shapes (bare array, an
    object with a `plan` array, a single action object) into a Plan

The first two were embedded Python heredocs inside llm.sh and could not be
unit-tested; the echo-variance defect survived for months for exactly that
reason.

`normalize_plan` normalises a planner reply into an action list. (An earlier version
of this docstring said that function did not exist in the committed tree —
true when written, since the multi-action pipeline was then uncommitted work
in the main checkout, and false since it landed in 9b9d3a7. Corrected rather
than deleted so the claim is not simply retracted without its history.)

One deliberate difference from the jq, recorded in the design spec's
known-differences section: `_to_action` drops wire fields whose value is an
empty string, so `{"postId": ""}` yields `post_id=None`. The jq keeps `""`,
which the guardrail's `(.postId // null) != null` then treats as present.
Nothing lands either way — the executor skips an action with no post id — but
Bash collapses two such actions to one in its dedupe and Python does not, so
the attempted tally and the veto list differ.
"""

from __future__ import annotations

import json
from typing import Any, get_args

from swil_agent.models import Action, ActionKind, Plan

_MIN_COLLAPSE_LENGTH = 40
_MAX_PLAN_BYTES = 16384
_VALID_KINDS = frozenset(get_args(ActionKind))

_WIRE_TO_FIELD = {
    "action": "kind",
    "postId": "post_id",
    "parentId": "parent_id",
    "imageTopic": "image_topic",
    "text": "text",
    "username": "username",
}

# Prompt v2's short keys (spec 2026-10-17 B2). Read only for a v2 prompt, and
# only when the long key is absent: a model that copies a raw id still works.
_HANDLE_TO_FIELD = {"post": "post_id", "reply": "parent_id"}


def collapse_doubled_text(text: str) -> str:
    """Collapse an exact full-length duplication (X+X, or X<sep>X) to one copy.

    Self-gating: it only fires when the two halves are byte-identical, which
    effectively never happens in genuine prose.
    """
    n = len(text)
    if n < _MIN_COLLAPSE_LENGTH:
        return text
    half = n // 2
    if n % 2 == 0 and text[:half] == text[half:]:
        return text[:half]
    if n % 2 == 1 and text[:half] == text[half + 1 :]:
        return text[:half]
    return text


def extract_json_object(text: str) -> str | None:
    """Return the first complete top-level JSON object, or None.

    Walks the string tracking brace depth, honouring quoted strings and
    backslash escapes. A greedy regex breaks on nested objects and on a `{`
    inside a string, which is why this is hand-rolled.
    """
    cleaned = text.replace("```json", "").replace("```", "")
    start = -1
    depth = 0
    in_string = False
    escaped = False
    for i, ch in enumerate(cleaned):
        if escaped:
            escaped = False
            continue
        if ch == "\\" and in_string:
            escaped = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}" and depth > 0:
            depth -= 1
            if depth == 0 and start >= 0:
                return cleaned[start : i + 1]
    return None


def _to_action(entry: dict[str, Any], *, handle_keys: bool = False) -> Action | None:
    kind = entry.get("action")
    if not isinstance(kind, str) or kind not in _VALID_KINDS:
        return None
    fields: dict[str, Any] = {}
    for wire, field in _WIRE_TO_FIELD.items():
        value = entry.get(wire)
        if isinstance(value, str) and value:
            fields[field] = value
    if handle_keys:
        for wire, field in _HANDLE_TO_FIELD.items():
            value = entry.get(wire)
            if field not in fields and isinstance(value, str) and value:
                fields[field] = value
        # v2 shows people as `@name`; the API takes the bare name.
        username = fields.get("username")
        if kind in ("follow", "dm") and isinstance(username, str) and username.startswith("@"):
            fields["username"] = username[1:]
            if not fields["username"]:
                del fields["username"]
    return Action(**fields)


def normalize_plan(raw: str, *, handle_keys: bool = False) -> Plan:
    """Flatten the three shapes the planner may emit into a Plan.

    `handle_keys` also reads v2's `post`/`reply` keys.
    """
    truncated = raw.encode("utf-8")[:_MAX_PLAN_BYTES].decode("utf-8", errors="ignore")
    try:
        parsed: Any = json.loads(truncated)
    except json.JSONDecodeError:
        extracted = extract_json_object(truncated)
        if extracted is None:
            return Plan(actions=[])
        try:
            parsed = json.loads(extracted)
        except json.JSONDecodeError:
            return Plan(actions=[])

    entries: list[Any]
    if isinstance(parsed, list):
        entries = parsed
    elif isinstance(parsed, dict) and isinstance(parsed.get("plan"), list):
        entries = parsed["plan"]
    elif isinstance(parsed, dict):
        entries = [parsed]
    else:
        return Plan(actions=[])

    actions = [
        action
        for entry in entries
        if isinstance(entry, dict)
        for action in (_to_action(entry, handle_keys=handle_keys),)
        if action is not None
    ]
    return Plan(actions=actions)

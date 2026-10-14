"""BYOK backend: the same `Backend` contract over a real HTTP API.

Spec §5.3 lists `ApiBackend` as the deferred fourth implementation of the
model-access seam, and gives the reason it has to exist: the three CLI
backends are bound to the maintainer's personal subscriptions, which does not
multi-tenant and cannot reach models the CLIs do not ship. This is that
implementation -- one class, two request shapes, no new dependency.

**Two protocols, because two shapes is all the market has.** Anthropic's
Messages API (`POST {base}/v1/messages`, `x-api-key`, system prompt as a
top-level field) and everything OpenAI-shaped (`POST {base}/chat/completions`,
`Authorization: Bearer`, system prompt as the first message). xAI, OpenAI,
Groq, Together, vLLM and DeepSeek's non-Anthropic endpoint all speak the
second one, so `openai_compatible` + an explicit base URL covers the long tail
without a class per vendor.

**What this does NOT do, on purpose.** No retries -- `api/client.py` already
records why (spec §5.4 puts retry policy on LangGraph's per-node
`RetryPolicy`, and a second loop here would double it). No streaming: every
call in this runtime is one-shot text-in/text-out, and the constitution layer
depends on the model's only channel to disk being its return value.

**Tool access.** The CLI backends carry `--tools ""` / `-s read-only` because
`claude -p` and `codex exec` are full agents with filesystem access. A chat
completions call has no tools unless the request asks for them, and this one
never does -- there is no `tools` key in either body below, and that absence is
the same guarantee those flags buy. See `llm/base.py`'s `--tools ""` comment
for the incident that made it a guarantee worth stating.
"""

from __future__ import annotations

from typing import Any

import httpx

from swil_agent.llm.base import (
    DEFAULT_TIMEOUT,
    BackendConfigurationError,
    BackendUnavailableError,
    CompletionRequest,
)
from swil_agent.llm.selection import PROVIDERS, BackendChoice

ANTHROPIC_VERSION = "2023-06-01"

# 401/403 -- the key is wrong, absent, or not entitled to this model. 404 --
# the model id does not exist at this provider, which is the single most likely
# mistake when pointing an existing persona at a new vendor. All three are
# setup problems the operator fixes in a config file, so they are raised as
# `BackendConfigurationError` and escape the round's degrade handlers; every
# other status is treated as the provider having a bad minute and degrades like
# a CLI that returned nothing.
_CONFIG_ERROR_STATUSES = frozenset({401, 403, 404})


class ApiBackend:
    """One provider, one model, one completion per call."""

    def __init__(
        self,
        *,
        provider: str,
        base_url: str,
        api_key: str,
        model: str,
        max_tokens: int,
        timeout: float = DEFAULT_TIMEOUT,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        if provider not in PROVIDERS:
            raise BackendConfigurationError(f"unknown provider {provider!r}")
        self._provider = PROVIDERS[provider]
        self.name = self._provider.wire
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._model = model
        self._max_tokens = max_tokens
        self._timeout = timeout
        # Same injection seam `cli.py`'s `_health_check` already uses, rather
        # than a mock library: tests pass an `httpx.MockTransport` and exercise
        # the real request-building and response-parsing code.
        self._transport = transport

    @classmethod
    def from_choice(
        cls,
        choice: BackendChoice,
        *,
        api_key: str,
        max_tokens: int,
        timeout: float = DEFAULT_TIMEOUT,
        transport: httpx.BaseTransport | None = None,
    ) -> ApiBackend:
        """Build from a resolved choice. `resolve_backend_choice` has already
        rejected an api choice with no provider, no base URL, or no model, so
        the three asserts below are invariants, not validation."""
        if choice.provider is None or choice.base_url is None or choice.model is None:
            raise BackendConfigurationError(
                "api backend choice is incomplete -- "
                f"provider={choice.provider!r} base_url={choice.base_url!r} model={choice.model!r}"
            )
        return cls(
            provider=choice.provider,
            base_url=choice.base_url,
            api_key=api_key,
            model=choice.model,
            max_tokens=max_tokens,
            timeout=timeout,
            transport=transport,
        )

    def complete(self, req: CompletionRequest) -> str:
        model = req.model or self._model
        url, headers, body = self._build(model, req)
        try:
            with httpx.Client(transport=self._transport, timeout=self._timeout) as client:
                response = client.post(url, headers=headers, json=body)
        except httpx.HTTPError as exc:
            # Connection refused, DNS failure, read timeout. Transient by
            # nature, so it degrades exactly like a CLI that printed nothing.
            raise BackendUnavailableError(f"{self.name} request failed: {exc}") from exc

        if response.status_code in _CONFIG_ERROR_STATUSES:
            raise BackendConfigurationError(
                f"{self.name} rejected the request: HTTP {response.status_code} "
                f"(model={model!r}) {_body_excerpt(response)}"
            )
        if response.status_code >= 400:
            raise BackendUnavailableError(
                f"{self.name} returned HTTP {response.status_code} {_body_excerpt(response)}"
            )

        text = self._parse(response)
        if not text.strip():
            # Same contract as every other backend: an empty answer is
            # "the model said nothing", which the callers degrade on.
            raise BackendUnavailableError(f"{self.name} produced no output")
        return text

    def _build(
        self, model: str, req: CompletionRequest
    ) -> tuple[str, dict[str, str], dict[str, Any]]:
        if self._provider.protocol == "anthropic":
            return (
                f"{self._base_url}/v1/messages",
                {
                    "x-api-key": self._api_key,
                    "anthropic-version": ANTHROPIC_VERSION,
                    "content-type": "application/json",
                },
                {
                    "model": model,
                    "max_tokens": self._max_tokens,
                    "system": req.system,
                    "messages": [{"role": "user", "content": req.user}],
                },
            )
        return (
            f"{self._base_url}/chat/completions",
            {
                "authorization": f"Bearer {self._api_key}",
                "content-type": "application/json",
            },
            {
                "model": model,
                "max_tokens": self._max_tokens,
                "messages": [
                    {"role": "system", "content": req.system},
                    {"role": "user", "content": req.user},
                ],
            },
        )

    def _parse(self, response: httpx.Response) -> str:
        try:
            payload = response.json()
        except ValueError as exc:
            raise BackendUnavailableError(
                f"{self.name} returned a non-JSON body {_body_excerpt(response)}"
            ) from exc
        if not isinstance(payload, dict):
            raise BackendUnavailableError(f"{self.name} returned a non-object body")
        if self._provider.protocol == "anthropic":
            return _anthropic_text(payload)
        return _openai_text(payload)


def _anthropic_text(payload: dict[str, Any]) -> str:
    """Join every text block. A Messages response is a LIST of blocks, and a
    model that emits two paragraphs as two blocks would lose all but the first
    under a `content[0]["text"]` read."""
    blocks = payload.get("content")
    if not isinstance(blocks, list):
        return ""
    parts = [
        block["text"]
        for block in blocks
        if isinstance(block, dict)
        and block.get("type") == "text"
        and isinstance(block.get("text"), str)
    ]
    return "".join(parts)


def _openai_text(payload: dict[str, Any]) -> str:
    """`choices[0].message.content`.

    Deliberately does NOT fall back to `reasoning_content`, which several
    reasoning models (DeepSeek's included) populate beside an empty `content`.
    That field is chain-of-thought; posting it would put a model's scratchpad
    into a persona's timeline and into the drift series measuring that
    persona's voice. An empty `content` is treated as "said nothing", which
    the callers already handle.
    """
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0]
    if not isinstance(first, dict):
        return ""
    message = first.get("message")
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    return content if isinstance(content, str) else ""


def _body_excerpt(response: httpx.Response, limit: int = 200) -> str:
    """A bounded slice of the error body.

    `api/client.py` keeps the response body of failed requests so that
    "HTTP 400: Invalid id" is visible in the logs; the same
    reasoning applies to a provider's error body, which is where "model not
    found" and "insufficient quota" actually say so. Bounded because some
    providers return an HTML error page.
    """
    try:
        text = response.text
    except Exception:  # pragma: no cover - httpx guarantees .text on a read body
        return ""
    text = " ".join(text.split())
    return f"-- {text[:limit]}" if text else ""

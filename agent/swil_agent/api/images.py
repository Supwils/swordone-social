"""Image fetch for image posts.

Returns bytes in memory rather than a temp file path, so there is no shared
temp-file resource for two concurrent callers to collide over and no
orphaned temp file to clean up on failure.

  * Unsplash: `GET https://api.unsplash.com/photos/random` (the RANDOM
    endpoint, NOT `/search/photos`) with `query`, `orientation=landscape`,
    and `content_filter=high`, authenticated via `Authorization: Client-ID
    <key>`. The response is a *single* JSON object; `.urls.regular` is read
    directly off the top level, not `.results[0].urls.regular` the way
    `/search/photos` would shape it.

  * Picsum fallback: used whenever the Unsplash attempt fails for ANY reason
    (missing `UNSPLASH_ACCESS_KEY`, a non-2xx search response, a malformed
    or keyless JSON body, a network failure on either request, an empty
    download). `fetch_unsplash_image` makes no distinction between failure
    classes. `_fetch_picsum` is lenient: a non-empty body is success
    regardless of status code.

    `_fetch_unsplash`'s download leg (the second `client.get`, fetching the
    URL Unsplash's search returned) is deliberately stricter: it rejects a
    non-2xx response even when the body is non-empty, so an error page is
    never uploaded as the photo. A caller only sees `ImageFetchError` (and
    therefore a text-only post) when the Unsplash download returns a
    non-2xx status AND Picsum also fails. See
    `test_unsplash_download_non_2xx_with_body_falls_back_to_picsum` and
    `test_picsum_http_error_with_non_empty_body_is_not_a_failure` for the two
    sides of this asymmetry.

Fail-soft: `fetch_unsplash_image` raises `ImageFetchError` only once BOTH
Unsplash and the Picsum fallback have failed, and the caller then posts
text-only. A raw httpx exception is never
allowed to escape this module -- both attempts are made inside the same
`with httpx.Client(...)` block and any `httpx.HTTPError` from either one is
caught alongside `ImageFetchError`, so `ImageFetchError` is the one type a
caller ever needs to catch.

`httpx.InvalidURL` is caught EXPLICITLY alongside them, and is not
redundant: it is NOT an `httpx.HTTPError` subclass
(`issubclass(httpx.InvalidURL, httpx.HTTPError)` is `False`), so it used to
escape this module entirely. Reachable, and the consequence was a dead
round rather than a text-only post: `_picsum_seed` replaces literal SPACES
only, so a TAB in a
planner-supplied `imageTopic` survives into the picsum URL, httpx rejects
it as a non-printable ASCII character, and the exception propagated out of
`execute_action`, out of the act round, and into the CLI's guard as
`SKIP <name> -- UNEXPECTED InvalidURL`, exit 75, with every remaining
action of that round unexecuted. It now degrades to a text-only post. Found while writing a test for
something else (ruling R22); pinned by
`test_a_control_character_in_the_topic_degrades_instead_of_escaping`.
"""

from __future__ import annotations

import re
import uuid
from typing import Any

import httpx

_UNSPLASH_RANDOM_URL = "https://api.unsplash.com/photos/random"
_PICSUM_URL_TEMPLATE = "https://picsum.photos/seed/{seed}/900/600"
DEFAULT_TIMEOUT = 20.0
_UNSAFE = re.compile(r"[^A-Za-z0-9_-]+")


class ImageFetchError(RuntimeError):
    """Any failure to obtain an image (Unsplash AND its Picsum fallback both
    failed). Never fatal to the post."""


def safe_temp_name(topic: str) -> str:
    """A multipart-safe filename, unique per call.

    No shared state backs this -- no file, no counter, no pid/time seed --
    so uniqueness comes entirely from `uuid.uuid4()`'s OS-CSPRNG randomness.
    There is no shared path for two concurrent callers (same process or
    separate OS processes) to race over.

    `topic` is sanitised down to `[A-Za-z0-9_-]`, so it can never introduce a
    path separator, a colon, or a newline into the resulting name.
    """
    slug = _UNSAFE.sub("_", topic).strip("_")[:40] or "image"
    return f"swil_img_{slug}_{uuid.uuid4().hex}.jpg"


def fetch_unsplash_image(
    topic: str,
    access_key: str,
    transport: httpx.BaseTransport | None = None,
) -> tuple[str, bytes]:
    """Fetch one image for `topic`: try Unsplash, fall back to Picsum on ANY
    failure, and raise `ImageFetchError` only once both have failed. Never
    returns a half-built result and never lets a raw httpx exception escape
    -- see the module docstring.
    """
    with httpx.Client(
        transport=transport, timeout=DEFAULT_TIMEOUT, follow_redirects=True
    ) as client:
        # `except ... as exc` unbinds `exc` at the end of its own except
        # block (Python 3 scoping), so the first failure is copied into this
        # plain variable rather than referenced by the except-clause name
        # once we're past it -- referencing the except-clause name itself
        # from the second except block below raises UnboundLocalError.
        unsplash_error: BaseException | None = None
        try:
            return _fetch_unsplash(client, topic, access_key)
        except (ImageFetchError, httpx.HTTPError, httpx.InvalidURL) as exc:
            unsplash_error = exc

        try:
            return _fetch_picsum(client, topic)
        except (ImageFetchError, httpx.HTTPError, httpx.InvalidURL) as exc:
            raise ImageFetchError(
                f"unsplash failed ({unsplash_error}); picsum fallback also failed ({exc})"
            ) from exc


def _fetch_unsplash(client: httpx.Client, topic: str, access_key: str) -> tuple[str, bytes]:
    """The Unsplash attempt. An empty `access_key` goes straight to the
    caller's Picsum fallback rather than sending an unauthenticated request.

    The download leg below rejects a non-2xx response even with a non-empty
    body, unlike the lenient Picsum leg. See the module docstring for why.
    """
    if not access_key:
        raise ImageFetchError("no unsplash access key configured")

    response = client.get(
        _UNSPLASH_RANDOM_URL,
        params={"query": topic, "orientation": "landscape", "content_filter": "high"},
        headers={"Authorization": f"Client-ID {access_key}"},
    )
    if response.status_code >= 400:
        raise ImageFetchError(f"unsplash search HTTP {response.status_code}: {response.text[:200]}")

    try:
        payload: Any = response.json()
    except ValueError as exc:
        raise ImageFetchError("unsplash search returned non-JSON") from exc

    url = _regular_url(payload)
    if url is None:
        raise ImageFetchError(f"no unsplash result for topic {topic!r}")

    download = client.get(url)
    if download.status_code >= 400:
        raise ImageFetchError(
            f"image download HTTP {download.status_code} "
            "(non-2xx; rejected even with a body -- see module docstring)"
        )
    if not download.content:
        raise ImageFetchError("image download returned an empty body")

    return safe_temp_name(topic), download.content


def _fetch_picsum(client: httpx.Client, topic: str) -> tuple[str, bytes]:
    """The Picsum fallback. Deliberately does NOT check the response status
    code; the only gate is "is the body non-empty".
    """
    url = _PICSUM_URL_TEMPLATE.format(seed=_picsum_seed(topic))
    download = client.get(url)
    if not download.content:
        raise ImageFetchError("picsum download returned an empty body")
    return safe_temp_name(topic), download.content


def _picsum_seed(topic: str) -> str:
    """Lowercase, literal spaces (only) become hyphens, then the first 24
    code points."""
    return topic.lower().replace(" ", "-")[:24]


def _regular_url(payload: Any) -> str | None:
    """Extract `.urls.regular` from a `/photos/random` response object.

    `/photos/random` returns a single JSON object when no `count` param is
    given (Bash never passes one) -- not a `{"results": [...]}` list, unlike
    `/search/photos`. A dict without a usable `urls.regular` string (missing
    keys, wrong types, or an empty string) yields `None` rather than
    raising, matching Bash's `jq -r '.urls.regular // empty'` fallback.
    """
    if not isinstance(payload, dict):
        return None
    urls = payload.get("urls")
    if not isinstance(urls, dict):
        return None
    url = urls.get("regular")
    return url if isinstance(url, str) and url else None

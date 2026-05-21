"""Async client for the Bettermode public GraphQL API.

The Sankhya community (``community.sankhya.com.br``) runs on Bettermode
(ex-Tribe). Anonymous access works through a read-only *guest token* that the
endpoint mints via the ``tokens(networkDomain: ...)`` query — no API key. The
token is a short-lived JWT (~4h); this client fetches it lazily and refreshes
it before expiry.

Only PUBLIC content is reachable with a guest token: private spaces come back
with ``private: true`` / ``postsCount: null`` and their posts are simply not
returned, so no special filtering is required beyond skipping private spaces.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import secrets
import time
from collections.abc import AsyncIterator
from typing import Any

import httpx
import structlog

from sankhya_ajuda.config import BettermodeSettings, get_settings

log = structlog.get_logger(__name__)

_HTTP_TOO_MANY = 429
_HTTP_SERVER_ERROR_MIN = 500
_MAX_SERVER_RETRIES = 3
_BACKOFF_BASE = 1.5

# Cap replies pulled per post: long threads add little retrieval signal beyond
# the first answers and would blow up embedding input.
_MAX_REPLIES_PER_POST = 50
# Max nesting depth to recurse into (reply -> reply -> ...). Guards against
# pathological deep threads; real threads rarely nest beyond a couple levels.
_MAX_REPLY_DEPTH = 5

# S105 is a false positive here: this is a GraphQL document, not a credential.
# The name contains "TOKEN" only because the query fetches the guest token.
_TOKEN_QUERY = "query($d:String!){ tokens(networkDomain:$d){ accessToken } }"  # noqa: S105

_SPACES_QUERY = (
    "query($l:Int!,$a:String){ spaces(limit:$l,after:$a){"
    " pageInfo{ endCursor hasNextPage }"
    " edges{ node{ id name slug url membersCount postsCount private } } } }"
)

_POSTS_QUERY = (
    "query($l:Int!,$a:String){ posts(limit:$l,after:$a){"
    " pageInfo{ endCursor hasNextPage }"
    " edges{ node{ id title url status createdAt updatedAt lastActivityAt"
    " reactionsCount totalRepliesCount isHidden postType{ name } space{ id }"
    " owner{ member{ name } } tags{ title } tagIds pinnedReplies{ id }"
    " fields{ key value } } } } }"
)

_REPLIES_QUERY = (
    "query($p:ID!,$l:Int!,$a:String){ replies(postId:$p,limit:$l,after:$a){"
    " pageInfo{ endCursor hasNextPage }"
    " edges{ node{ id createdAt totalRepliesCount owner{ member{ name } }"
    " fields{ key value } } } } }"
)


class BettermodeError(RuntimeError):
    """Raised when the GraphQL endpoint fails permanently or returns errors."""


def field_value(node: dict[str, Any], key: str) -> Any:
    """Read a Bettermode ``fields`` entry. Values are JSON-encoded scalars
    (e.g. ``"\\"<p>..</p>\\""`` or ``"null"``), so they are decoded here."""
    for f in node.get("fields") or []:
        if f.get("key") == key:
            raw = f.get("value")
            if raw is None:
                return None
            try:
                return json.loads(raw)
            except (ValueError, TypeError):
                return raw
    return None


def _jwt_exp(token: str) -> int:
    """Extract the ``exp`` (epoch seconds) from a JWT without verifying it.

    The token is opaque to us; we only need its expiry to know when to refresh.
    """
    try:
        payload = token.split(".")[1]
        padding = "=" * (-len(payload) % 4)
        decoded = base64.urlsafe_b64decode(payload + padding)
        return int(json.loads(decoded)["exp"])
    except (IndexError, KeyError, ValueError, binascii.Error):
        # Unknown shape: treat as already expired so we refresh eagerly.
        return 0


class BettermodeClient:
    """Thin wrapper around the Bettermode GraphQL endpoint (guest auth)."""

    def __init__(self, settings: BettermodeSettings | None = None) -> None:
        self._cfg = settings or get_settings().bettermode
        self._client = httpx.AsyncClient(
            base_url=self._cfg.api_url.rstrip("/"),
            timeout=self._cfg.timeout,
            headers={
                "User-Agent": self._cfg.user_agent,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        self._token: str | None = None
        self._token_exp: int = 0

    async def close(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> BettermodeClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    # ----- guest token lifecycle -----
    async def _ensure_token(self) -> str:
        now = time.time()
        if self._token and now < self._token_exp - self._cfg.token_refresh_margin:
            return self._token
        data = await self._request(
            {"query": _TOKEN_QUERY, "variables": {"d": self._cfg.network_domain}},
            auth=False,
        )
        token = (data.get("tokens") or {}).get("accessToken")
        if not token:
            raise BettermodeError("guest token missing in tokens query response")
        self._token = token
        self._token_exp = _jwt_exp(token)
        log.info("bettermode.token_refreshed", exp=self._token_exp)
        return token

    # ----- streaming spaces -----
    async def iter_spaces(self) -> AsyncIterator[dict[str, Any]]:
        """Yield every space (public and private). Callers skip private ones."""
        async for node in self._paginate(_SPACES_QUERY, root="spaces", variables={}):
            yield node

    # ----- streaming posts (global, all public spaces) -----
    async def iter_posts(self) -> AsyncIterator[dict[str, Any]]:
        """Yield every public post across all public spaces, newest first."""
        async for node in self._paginate(_POSTS_QUERY, root="posts", variables={}):
            yield node

    # ----- replies for a post (full tree, capped) -----
    async def fetch_replies(self, post_id: str) -> list[dict[str, Any]]:
        """Return the full reply tree depth-first, capped at
        ``_MAX_REPLIES_PER_POST``. Bettermode nests replies (a reply is itself a
        post with its own replies), so children are fetched recursively; each
        returned node carries a ``_depth`` marker (0 = direct reply to the post).
        """
        out: list[dict[str, Any]] = []
        await self._collect_replies(post_id, depth=0, out=out)
        return out

    async def _collect_replies(
        self, parent_id: str, *, depth: int, out: list[dict[str, Any]]
    ) -> None:
        async for node in self._paginate(
            _REPLIES_QUERY, root="replies", variables={"p": parent_id}
        ):
            if len(out) >= _MAX_REPLIES_PER_POST:
                return
            node["_depth"] = depth
            out.append(node)
            if (node.get("totalRepliesCount") or 0) > 0 and depth < _MAX_REPLY_DEPTH:
                await self._collect_replies(node["id"], depth=depth + 1, out=out)

    # ----- internals -----
    async def _paginate(
        self, query: str, *, root: str, variables: dict[str, Any]
    ) -> AsyncIterator[dict[str, Any]]:
        """Drive Bettermode cursor pagination for any ``{ edges, pageInfo }`` root."""
        after: str | None = None
        page = 0
        while True:
            page += 1
            payload = {
                "query": query,
                "variables": {**variables, "l": self._cfg.page_size, "a": after},
            }
            data = await self._request(payload, auth=True)
            conn = data.get(root) or {}
            edges = conn.get("edges") or []
            for edge in edges:
                node = edge.get("node")
                if node:
                    yield node
            page_info = conn.get("pageInfo") or {}
            log.info("bettermode.page", root=root, page=page, in_page=len(edges))
            if not page_info.get("hasNextPage") or not edges:
                break
            after = page_info.get("endCursor")
            await asyncio.sleep(self._cfg.delay)

    async def _request(self, payload: dict[str, Any], *, auth: bool) -> dict[str, Any]:
        """POST a GraphQL document with retry/backoff; raise on GraphQL errors."""
        attempt = 0
        while True:
            attempt += 1
            headers = {}
            if auth:
                headers["Authorization"] = f"Bearer {await self._ensure_token()}"
            try:
                resp = await self._client.post("/", json=payload, headers=headers)
            except httpx.RequestError as exc:
                if attempt < _MAX_SERVER_RETRIES:
                    await self._sleep_backoff(attempt, str(exc))
                    continue
                raise BettermodeError(f"network error: {exc}") from exc

            if resp.status_code == _HTTP_TOO_MANY:
                retry_after = float(resp.headers.get("Retry-After", "5"))
                log.warning("bettermode.rate_limited", retry_after=retry_after)
                await asyncio.sleep(retry_after)
                continue
            if (
                resp.status_code >= _HTTP_SERVER_ERROR_MIN
                and attempt < _MAX_SERVER_RETRIES
            ):
                await self._sleep_backoff(attempt, f"HTTP {resp.status_code}")
                continue
            resp.raise_for_status()

            body = resp.json()
            if body.get("errors"):
                raise BettermodeError(f"graphql errors: {body['errors']}")
            return body.get("data") or {}

    async def _sleep_backoff(self, attempt: int, reason: str) -> None:
        # Full-jitter exponential backoff, matching the embeddings client policy.
        base_delay = _BACKOFF_BASE**attempt
        jitter = secrets.SystemRandom().uniform(0.0, base_delay / 2)
        log.warning("bettermode.retry", attempt=attempt, error=reason)
        await asyncio.sleep(base_delay + jitter)

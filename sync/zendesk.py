"""Async client for the Zendesk Help Center public REST API.

The Sankhya Help Center is hosted on Zendesk at ``ajuda.sankhya.com.br``.
All endpoints used here are public (no auth required).
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import httpx
import structlog

from sankhya_ajuda.config import ZendeskSettings, get_settings

log = structlog.get_logger(__name__)

_HTTP_TOO_MANY = 429
_HTTP_SERVER_ERROR_MIN = 500
_MAX_SERVER_RETRIES = 3


class ZendeskClient:
    """Thin wrapper around the Help Center paginated endpoints."""

    def __init__(self, settings: ZendeskSettings | None = None) -> None:
        self._cfg = settings or get_settings().zendesk
        self._client = httpx.AsyncClient(
            base_url=self._cfg.base.rstrip("/"),
            timeout=60.0,
            headers={"User-Agent": self._cfg.user_agent, "Accept": "application/json"},
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> ZendeskClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    # ----- single-page helpers -----
    async def list_categories(self) -> list[dict[str, Any]]:
        return await self._collect(
            f"/api/v2/help_center/{self._cfg.locale}/categories.json",
            key="categories",
        )

    async def list_sections(self) -> list[dict[str, Any]]:
        return await self._collect(
            f"/api/v2/help_center/{self._cfg.locale}/sections.json",
            key="sections",
        )

    # ----- streaming articles (paginated) -----
    async def iter_articles(
        self, category_id: int | None = None
    ) -> AsyncIterator[dict[str, Any]]:
        """Yield every article one by one.

        When ``category_id`` is supplied, only that category is fetched (used by
        the test-load path).
        """
        if category_id is not None:
            path = (
                f"/api/v2/help_center/{self._cfg.locale}"
                f"/categories/{category_id}/articles.json"
            )
        else:
            path = f"/api/v2/help_center/{self._cfg.locale}/articles.json"

        params = {"per_page": self._cfg.per_page}
        page = 1
        while True:
            data = await self._get(path, params={**params, "page": page})
            articles = data.get("articles", [])
            if not articles:
                break
            for art in articles:
                yield art
            page_count = data.get("page_count", 1)
            log.info(
                "zendesk.articles_page",
                page=page,
                page_count=page_count,
                in_page=len(articles),
            )
            if page >= page_count:
                break
            page += 1
            await asyncio.sleep(self._cfg.delay)

    # ----- internals -----
    async def _collect(self, path: str, *, key: str) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        params = {"per_page": self._cfg.per_page}
        page = 1
        while True:
            data = await self._get(path, params={**params, "page": page})
            items = data.get(key, [])
            out.extend(items)
            page_count = data.get("page_count", 1)
            if page >= page_count or not items:
                break
            page += 1
            await asyncio.sleep(self._cfg.delay)
        return out

    async def _get(self, path: str, *, params: dict[str, Any]) -> dict[str, Any]:
        attempt = 0
        while True:
            attempt += 1
            resp = await self._client.get(path, params=params)
            if resp.status_code == _HTTP_TOO_MANY:
                retry_after = float(resp.headers.get("Retry-After", "5"))
                log.warning("zendesk.rate_limited", retry_after=retry_after)
                await asyncio.sleep(retry_after)
                continue
            if resp.status_code >= _HTTP_SERVER_ERROR_MIN and attempt < _MAX_SERVER_RETRIES:
                backoff = 2.0**attempt
                log.warning(
                    "zendesk.server_error",
                    status=resp.status_code,
                    attempt=attempt,
                    backoff=backoff,
                )
                await asyncio.sleep(backoff)
                continue
            resp.raise_for_status()
            return resp.json()

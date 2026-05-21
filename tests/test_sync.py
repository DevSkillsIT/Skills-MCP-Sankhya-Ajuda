"""Integration-style tests for sync/sync.py with mocked I/O.

These tests exercise the SyncRunner orchestration. The real Zendesk client,
embedding client, and database layer are all replaced so the suite runs
hermetically (no network, no postgres).
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest

from sankhya_ajuda.embeddings import EmbeddingError
from sync import sync as sync_mod


def _article(article_id: int, *, body: str = "<p>hello</p>") -> dict[str, Any]:
    return {
        "id": article_id,
        "section_id": 99,
        "title": f"Article {article_id}",
        "html_url": f"https://h.example/{article_id}",
        "body": body,
        "label_names": [],
        "content_tag_ids": [],
        "outdated": False,
        "author_id": 42,
        "locale": "pt-br",
        "draft": False,
        "promoted": False,
        "vote_sum": 0,
        "vote_count": 0,
        "created_at": "2025-01-01T00:00:00Z",
        "updated_at": "2025-01-02T00:00:00Z",
        "edited_at": "2025-01-02T00:00:00Z",
    }


class FakeZendeskClient:
    """Async context manager returning canned categories / sections / articles."""

    def __init__(self, articles: list[dict[str, Any]]) -> None:
        self._articles = articles

    async def __aenter__(self) -> FakeZendeskClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    async def list_categories(self) -> list[dict[str, Any]]:
        return [
            {
                "id": 1,
                "name": "Cat",
                "description": "",
                "html_url": "",
                "position": 0,
                "locale": "pt-br",
                "created_at": "2025-01-01T00:00:00Z",
                "updated_at": "2025-01-01T00:00:00Z",
            }
        ]

    async def list_sections(self) -> list[dict[str, Any]]:
        return [
            {
                "id": 99,
                "category_id": 1,
                "name": "Sec",
                "description": "",
                "html_url": "",
                "position": 0,
                "locale": "pt-br",
                "created_at": "2025-01-01T00:00:00Z",
                "updated_at": "2025-01-01T00:00:00Z",
            }
        ]

    async def iter_articles(self, category_id: int | None = None):
        for art in self._articles:
            yield art


class FakeEmbeddingClient:
    def __init__(self, raises: bool = False) -> None:
        self._raises = raises
        self.calls = 0

    async def __aenter__(self) -> FakeEmbeddingClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    async def embed(self, text: str) -> list[float]:
        self.calls += 1
        if self._raises:
            raise EmbeddingError("forced failure")
        return [0.1] * 2560


@pytest.fixture
def patched_db(monkeypatch: pytest.MonkeyPatch) -> dict[str, AsyncMock]:
    mocks = {
        "begin_sync": AsyncMock(),
        "finish_sync": AsyncMock(),
        "close_pool": AsyncMock(),
        "upsert_category": AsyncMock(),
        "upsert_section": AsyncMock(),
        "update_section_parents": AsyncMock(),
        "get_article_hash": AsyncMock(return_value=None),
        "upsert_article_full": AsyncMock(),
        "upsert_article_metadata": AsyncMock(),
        "record_skipped_article": AsyncMock(),
        "refresh_breadcrumbs": AsyncMock(return_value=0),
        "delete_orphan_articles": AsyncMock(return_value=0),
    }
    for name, mock in mocks.items():
        monkeypatch.setattr(sync_mod.db, name, mock)
    # parse_zendesk_ts is a pure helper, no need to mock.
    return mocks


@pytest.fixture
def patch_clients(monkeypatch: pytest.MonkeyPatch):
    def _apply(zd: FakeZendeskClient, emb: FakeEmbeddingClient) -> None:
        monkeypatch.setattr(sync_mod, "ZendeskClient", lambda: zd)
        monkeypatch.setattr(sync_mod, "EmbeddingClient", lambda: emb)

    return _apply


@pytest.mark.asyncio
async def test_full_sync_indexes_new_articles(
    patched_db: dict[str, AsyncMock], patch_clients
) -> None:
    articles = [_article(i) for i in range(3)]
    emb = FakeEmbeddingClient()
    patch_clients(FakeZendeskClient(articles), emb)

    runner = sync_mod.SyncRunner(category_id=None, limit=None, dry_run=False)
    rc = await runner.run()

    assert rc == 0
    assert runner.processed == 3
    assert runner.changed == 3
    assert runner.unchanged == 0
    assert emb.calls == 3  # one embedding per new article
    assert patched_db["upsert_article_full"].await_count == 3
    assert patched_db["upsert_article_metadata"].await_count == 0
    patched_db["begin_sync"].assert_awaited_once()
    patched_db["finish_sync"].assert_awaited_once()
    finish_call = patched_db["finish_sync"].await_args
    assert finish_call is not None
    args = finish_call.kwargs
    assert args["status"] == "ok"
    assert args["article_count"] == 3
    assert args["changed_count"] == 3


@pytest.mark.asyncio
async def test_skip_unchanged_article(
    patched_db: dict[str, AsyncMock], patch_clients
) -> None:
    arts = [_article(1)]
    emb = FakeEmbeddingClient()
    patch_clients(FakeZendeskClient(arts), emb)

    # Pre-compute hash so DB pretends the article is unchanged.
    from sync import parser as html_parser

    cleaned = html_parser.clean_html(arts[0]["body"])
    body_text = html_parser.build_body_text(arts[0]["title"], cleaned)
    expected_hash = html_parser.compute_hash(body_text)
    patched_db["get_article_hash"] = AsyncMock(return_value=expected_hash)
    # Re-bind because monkeypatch in fixture already set the original mock.
    sync_mod.db.get_article_hash = patched_db["get_article_hash"]

    runner = sync_mod.SyncRunner(category_id=None, limit=None, dry_run=False)
    await runner.run()

    assert runner.changed == 0
    assert runner.unchanged == 1
    assert emb.calls == 0
    assert patched_db["upsert_article_full"].await_count == 0
    assert patched_db["upsert_article_metadata"].await_count == 1


@pytest.mark.asyncio
async def test_dry_run_writes_nothing(
    patched_db: dict[str, AsyncMock], patch_clients
) -> None:
    arts = [_article(i) for i in range(2)]
    emb = FakeEmbeddingClient()
    patch_clients(FakeZendeskClient(arts), emb)

    runner = sync_mod.SyncRunner(category_id=None, limit=None, dry_run=True)
    rc = await runner.run()

    assert rc == 0
    assert runner.processed == 2
    assert runner.changed == 0
    assert runner.unchanged == 0
    assert emb.calls == 0  # no embeddings in dry-run
    patched_db["begin_sync"].assert_not_awaited()
    patched_db["finish_sync"].assert_not_awaited()
    patched_db["upsert_article_full"].assert_not_awaited()


@pytest.mark.asyncio
async def test_limit_respected(
    patched_db: dict[str, AsyncMock], patch_clients
) -> None:
    arts = [_article(i) for i in range(10)]
    emb = FakeEmbeddingClient()
    patch_clients(FakeZendeskClient(arts), emb)

    runner = sync_mod.SyncRunner(category_id=None, limit=3, dry_run=False)
    await runner.run()

    assert runner.processed == 3
    assert runner.changed == 3


@pytest.mark.asyncio
async def test_embed_failure_aborts_sync(
    patched_db: dict[str, AsyncMock], patch_clients
) -> None:
    arts = [_article(1)]
    emb = FakeEmbeddingClient(raises=True)
    patch_clients(FakeZendeskClient(arts), emb)

    runner = sync_mod.SyncRunner(category_id=None, limit=None, dry_run=False)
    with pytest.raises(EmbeddingError):
        await runner.run()

    # finish_sync is still called from finally with status='error'
    patched_db["finish_sync"].assert_awaited_once()
    finish_call = patched_db["finish_sync"].await_args
    assert finish_call is not None
    args = finish_call.kwargs
    assert args["status"] == "error"


@pytest.mark.asyncio
async def test_article_payload_carries_new_fields(
    patched_db: dict[str, AsyncMock], patch_clients
) -> None:
    """Outdated / author_id / content_tag_ids must reach the DB layer."""
    arts = [_article(1)]
    arts[0]["outdated"] = True
    arts[0]["author_id"] = 999
    arts[0]["content_tag_ids"] = ["uuid-a", "uuid-b"]
    emb = FakeEmbeddingClient()
    patch_clients(FakeZendeskClient(arts), emb)

    runner = sync_mod.SyncRunner(category_id=None, limit=None, dry_run=False)
    await runner.run()

    full_call = patched_db["upsert_article_full"].await_args
    assert full_call is not None
    sent = full_call.args[0]
    assert sent["outdated"] is True
    assert sent["author_id"] == 999
    assert sent["content_tag_ids"] == ["uuid-a", "uuid-b"]


@pytest.mark.asyncio
async def test_section_parent_two_pass(
    patched_db: dict[str, AsyncMock], patch_clients, monkeypatch: pytest.MonkeyPatch
) -> None:
    """upsert_section is called per row, then update_section_parents once."""

    class ZdWithParent(FakeZendeskClient):
        async def list_sections(self) -> list[dict[str, Any]]:  # type: ignore[override]
            return [
                {
                    "id": 99,
                    "category_id": 1,
                    "parent_section_id": 50,
                    "name": "child",
                    "description": "",
                    "html_url": "",
                    "position": 0,
                    "locale": "pt-br",
                    "created_at": "2025-01-01T00:00:00Z",
                    "updated_at": "2025-01-01T00:00:00Z",
                },
                {
                    "id": 50,
                    "category_id": 1,
                    "parent_section_id": None,
                    "name": "parent",
                    "description": "",
                    "html_url": "",
                    "position": 0,
                    "locale": "pt-br",
                    "created_at": "2025-01-01T00:00:00Z",
                    "updated_at": "2025-01-01T00:00:00Z",
                },
            ]

    emb = FakeEmbeddingClient()
    patch_clients(ZdWithParent([]), emb)

    runner = sync_mod.SyncRunner(category_id=None, limit=None, dry_run=False)
    await runner.run()

    # Both sections upserted, then the parents linked in a single call.
    assert patched_db["upsert_section"].await_count == 2
    patched_db["update_section_parents"].assert_awaited_once()
    parents_call = patched_db["update_section_parents"].await_args
    assert parents_call is not None
    parent_map = parents_call.args[0]
    assert parent_map == {99: 50, 50: None}


@pytest.mark.asyncio
async def test_category_filter_skips_other_sections(
    patched_db: dict[str, AsyncMock], patch_clients
) -> None:
    zd = FakeZendeskClient([_article(1)])
    emb = FakeEmbeddingClient()
    patch_clients(zd, emb)

    # Section belongs to category 1; runner filters for category 2.
    runner = sync_mod.SyncRunner(category_id=2, limit=None, dry_run=False)
    await runner.run()

    # upsert_section called 0 times because no section matched category_id=2
    assert patched_db["upsert_section"].await_count == 0

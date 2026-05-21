"""Integration-style tests for sync/community_sync.py with mocked I/O.

Mirrors tests/test_sync.py: the Bettermode client, embedding client, repository
and sync-state helpers are all replaced so the suite runs hermetically.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest

from sankhya_ajuda import db
from sankhya_ajuda.embeddings import EmbeddingError, EmbeddingTooLongError
from sync import community_sync as cs


def _post(
    post_id: str,
    *,
    content: str = "<p>pergunta</p>",
    replies: int = 0,
    space_id: str = "SP1",
    activity: str = "2025-01-02T00:00:00Z",
    post_type: str = "Pergunta",
) -> dict[str, Any]:
    return {
        "id": post_id,
        "title": f"Post {post_id}",
        "url": f"https://c.example/{post_id}",
        "status": "PUBLISHED",
        "createdAt": "2025-01-01T00:00:00Z",
        "updatedAt": "2025-01-02T00:00:00Z",
        "lastActivityAt": activity,
        "reactionsCount": 0,
        "totalRepliesCount": replies,
        "postType": {"name": post_type},
        "space": {"id": space_id},
        "owner": {"member": {"name": "Autor"}},
        "fields": [{"key": "content", "value": f'"{content}"'}],
    }


def _reply(content: str, author: str = "Respondente") -> dict[str, Any]:
    return {
        "id": "r1",
        "createdAt": "2025-01-03T00:00:00Z",
        "owner": {"member": {"name": author}},
        "fields": [{"key": "content", "value": f'"{content}"'}],
    }


class FakeBettermodeClient:
    def __init__(
        self,
        posts: list[dict[str, Any]],
        spaces: list[dict[str, Any]] | None = None,
        replies: list[dict[str, Any]] | None = None,
    ) -> None:
        self._posts = posts
        self._spaces = spaces or [{"id": "SP1", "name": "Space 1", "private": False}]
        self._replies = replies or []

    async def __aenter__(self) -> FakeBettermodeClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    async def iter_spaces(self):
        for sp in self._spaces:
            yield sp

    async def iter_posts(self):
        for p in self._posts:
            yield p

    async def fetch_replies(self, post_id: str) -> list[dict[str, Any]]:
        return self._replies


class FakeEmbeddingClient:
    def __init__(self, raises: bool = False, too_long: bool = False) -> None:
        self._raises = raises
        self._too_long = too_long
        self.calls = 0

    async def __aenter__(self) -> FakeEmbeddingClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    async def embed(self, text: str) -> list[float]:
        self.calls += 1
        if self._too_long:
            raise EmbeddingTooLongError("context length exceeded")
        if self._raises:
            raise EmbeddingError("forced failure")
        return [0.1] * 2560


class FakeRepo:
    def __init__(
        self,
        hashes: dict[str, str] | None = None,
        change_keys: dict[str, Any] | None = None,
    ) -> None:
        self.hashes = hashes or {}
        self.change_keys = change_keys or {}
        self.full: list[dict[str, Any]] = []
        self.metadata: list[str] = []
        self.skipped: list[str] = []
        self.deleted: list[str] | None = None

    async def get_hash(self, external_id: str) -> str | None:
        return self.hashes.get(external_id)

    async def get_change_keys(self, external_id: str):
        return self.change_keys.get(external_id)

    async def upsert_full(
        self, doc, *, body_text, body_hash, embedding, embedding_model
    ) -> None:
        self.full.append({"id": doc.external_id, "body_text": body_text})

    async def upsert_metadata(self, doc, *, body_text) -> None:
        self.metadata.append(doc.external_id)

    async def record_skipped(self, doc, *, reason, body_len) -> None:
        self.skipped.append(doc.external_id)

    async def delete_orphans(self, active_ids) -> int:
        self.deleted = list(active_ids)
        return 0


@pytest.fixture
def patched_state(monkeypatch: pytest.MonkeyPatch) -> dict[str, AsyncMock]:
    mocks = {
        "begin_community_sync": AsyncMock(),
        "finish_community_sync": AsyncMock(),
        "upsert_community_space": AsyncMock(),
    }
    for name, mock in mocks.items():
        monkeypatch.setattr(cs.community_db, name, mock)
    monkeypatch.setattr(cs.db, "close_pool", AsyncMock())
    return mocks


@pytest.fixture
def patch_clients(monkeypatch: pytest.MonkeyPatch):
    def _apply(
        client: FakeBettermodeClient, emb: FakeEmbeddingClient, repo: FakeRepo
    ) -> None:
        monkeypatch.setattr(cs, "BettermodeClient", lambda: client)
        monkeypatch.setattr(cs, "EmbeddingClient", lambda: emb)
        monkeypatch.setattr(cs, "CommunityRepository", lambda: repo)

    return _apply


@pytest.mark.asyncio
async def test_full_sync_indexes_new_posts(patched_state, patch_clients) -> None:
    posts = [_post(f"p{i}") for i in range(3)]
    repo = FakeRepo()
    emb = FakeEmbeddingClient()
    patch_clients(FakeBettermodeClient(posts), emb, repo)

    runner = cs.CommunitySyncRunner(space_id=None, limit=None, dry_run=False)
    rc = await runner.run()

    assert rc == 0
    assert runner.processed == 3
    assert emb.calls == 3
    assert len(repo.full) == 3
    assert repo.metadata == []
    patched_state["begin_community_sync"].assert_awaited_once()
    finish_call = patched_state["finish_community_sync"].await_args
    assert finish_call is not None
    args = finish_call.kwargs
    assert args["status"] == "ok"
    assert args["post_count"] == 3
    assert args["changed_count"] == 3


@pytest.mark.asyncio
async def test_activity_gate_skips_unchanged_thread(patched_state, patch_clients) -> None:
    posts = [_post("p1", activity="2025-01-02T00:00:00Z")]
    # Both gate keys (last_activity_at, updated_at) match the post -> unchanged.
    stored = (
        db.parse_zendesk_ts("2025-01-02T00:00:00Z"),
        db.parse_zendesk_ts("2025-01-02T00:00:00Z"),
    )
    repo = FakeRepo(change_keys={"p1": stored})
    emb = FakeEmbeddingClient()
    patch_clients(FakeBettermodeClient(posts), emb, repo)

    runner = cs.CommunitySyncRunner(space_id=None, limit=None, dry_run=False)
    await runner.run()

    assert runner.unchanged_activity == 1
    assert emb.calls == 0  # no embedding for an unchanged thread
    assert repo.full == []
    assert repo.metadata == ["p1"]  # light metadata refresh only


@pytest.mark.asyncio
async def test_post_edit_bumps_updated_at_triggers_reindex(
    patched_state, patch_clients
) -> None:
    # Same lastActivityAt (no new reply) but a newer updatedAt (post edited) must
    # NOT be skipped by the change gate — it has to be re-embedded.
    posts = [_post("p1", activity="2025-01-02T00:00:00Z")]
    posts[0]["updatedAt"] = "2025-06-01T00:00:00Z"
    stored = (
        db.parse_zendesk_ts("2025-01-02T00:00:00Z"),
        db.parse_zendesk_ts("2025-01-02T00:00:00Z"),  # stale updated_at
    )
    repo = FakeRepo(change_keys={"p1": stored})
    emb = FakeEmbeddingClient()
    patch_clients(FakeBettermodeClient(posts), emb, repo)

    runner = cs.CommunitySyncRunner(space_id=None, limit=None, dry_run=False)
    await runner.run()

    assert runner.unchanged_activity == 0
    assert len(repo.full) == 1  # reprocessed despite unchanged activity
    assert emb.calls == 1


@pytest.mark.asyncio
async def test_changed_thread_fetches_replies_into_body(patched_state, patch_clients) -> None:
    posts = [_post("p1", content="<p>como faz?</p>", replies=1)]
    replies = [_reply("<p>faz assim</p>", author="Maria")]
    repo = FakeRepo()  # new post -> no stored activity
    emb = FakeEmbeddingClient()
    patch_clients(FakeBettermodeClient(posts, replies=replies), emb, repo)

    runner = cs.CommunitySyncRunner(space_id=None, limit=None, dry_run=False)
    await runner.run()

    assert len(repo.full) == 1
    body = repo.full[0]["body_text"]
    assert "como faz?" in body
    assert "faz assim" in body  # reply content folded into the indexed thread
    assert "Maria" in body  # reply author attributed


@pytest.mark.asyncio
async def test_dry_run_writes_nothing(patched_state, patch_clients) -> None:
    posts = [_post(f"p{i}") for i in range(2)]
    repo = FakeRepo()
    emb = FakeEmbeddingClient()
    patch_clients(FakeBettermodeClient(posts), emb, repo)

    runner = cs.CommunitySyncRunner(space_id=None, limit=None, dry_run=True)
    rc = await runner.run()

    assert rc == 0
    assert runner.processed == 2
    assert emb.calls == 0
    assert repo.full == []
    patched_state["begin_community_sync"].assert_not_awaited()
    patched_state["finish_community_sync"].assert_not_awaited()


@pytest.mark.asyncio
async def test_limit_respected(patched_state, patch_clients) -> None:
    posts = [_post(f"p{i}") for i in range(10)]
    repo = FakeRepo()
    emb = FakeEmbeddingClient()
    patch_clients(FakeBettermodeClient(posts), emb, repo)

    runner = cs.CommunitySyncRunner(space_id=None, limit=3, dry_run=False)
    await runner.run()

    assert runner.processed == 3
    assert len(repo.full) == 3


@pytest.mark.asyncio
async def test_space_filter(patched_state, patch_clients) -> None:
    posts = [_post("p1", space_id="SP1"), _post("p2", space_id="SP2")]
    repo = FakeRepo()
    emb = FakeEmbeddingClient()
    patch_clients(FakeBettermodeClient(posts), emb, repo)

    runner = cs.CommunitySyncRunner(space_id="SP2", limit=None, dry_run=False)
    await runner.run()

    assert runner.processed == 1
    assert repo.full[0]["id"] == "p2"


@pytest.mark.asyncio
async def test_private_spaces_skipped(patched_state, patch_clients) -> None:
    spaces = [
        {"id": "SP1", "name": "Pub", "private": False},
        {"id": "SP2", "name": "Priv", "private": True},
    ]
    repo = FakeRepo()
    emb = FakeEmbeddingClient()
    patch_clients(FakeBettermodeClient([], spaces=spaces), emb, repo)

    runner = cs.CommunitySyncRunner(space_id=None, limit=None, dry_run=False)
    await runner.run()

    assert runner.public_spaces == 1
    assert runner.private_spaces == 1
    # Only the public space is persisted.
    assert patched_state["upsert_community_space"].await_count == 1


@pytest.mark.asyncio
async def test_embed_failure_aborts_sync(patched_state, patch_clients) -> None:
    posts = [_post("p1")]
    repo = FakeRepo()
    emb = FakeEmbeddingClient(raises=True)
    patch_clients(FakeBettermodeClient(posts), emb, repo)

    runner = cs.CommunitySyncRunner(space_id=None, limit=None, dry_run=False)
    with pytest.raises(EmbeddingError):
        await runner.run()

    finish_call = patched_state["finish_community_sync"].await_args
    assert finish_call is not None
    args = finish_call.kwargs
    assert args["status"] == "error"


@pytest.mark.asyncio
async def test_post_without_space_is_skipped(patched_state, patch_clients) -> None:
    # A post with no space would violate the NOT NULL + FK on space_id; the
    # runner must skip it defensively instead of aborting the whole sync.
    posts = [_post("p1")]
    posts[0]["space"] = {}
    repo = FakeRepo()
    emb = FakeEmbeddingClient()
    patch_clients(FakeBettermodeClient(posts), emb, repo)

    runner = cs.CommunitySyncRunner(space_id=None, limit=None, dry_run=False)
    await runner.run()

    assert runner.skipped_no_space == 1
    assert runner.processed == 0
    assert repo.full == []
    assert emb.calls == 0


@pytest.mark.asyncio
async def test_embed_too_long_keeps_post_without_embedding(
    patched_state, patch_clients
) -> None:
    # Thread too long to embed: keep the post (FTS still finds it) and record it
    # as skipped, rather than aborting the sync.
    posts = [_post("p1")]
    repo = FakeRepo()
    emb = FakeEmbeddingClient(too_long=True)
    patch_clients(FakeBettermodeClient(posts), emb, repo)

    runner = cs.CommunitySyncRunner(space_id=None, limit=None, dry_run=False)
    rc = await runner.run()

    assert rc == 0
    assert len(repo.full) == 1  # post still persisted
    assert repo.skipped == ["p1"]  # audited as skipped-embedding

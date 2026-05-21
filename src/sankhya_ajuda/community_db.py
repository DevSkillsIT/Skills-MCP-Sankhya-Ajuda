"""PostgreSQL persistence for the community source (community_* tables).

Reuses the shared async pool from :mod:`sankhya_ajuda.db` (same database, same
``register_vector_async`` setup) and implements the
:class:`~sankhya_ajuda.sources.base.Repository` protocol so the generic
:class:`~sankhya_ajuda.indexer.DocumentIndexer` can drive it. Mirrors the help
center's db helpers but keyed by TEXT ids (Bettermode) and writing to
``community_posts`` / ``community_spaces`` / ``community_sync_state``.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from datetime import datetime
from typing import Any, cast

import structlog

from .db import acquire
from .sources.base import Document

log = structlog.get_logger(__name__)


# ---------------------------------------------------------------------
# spaces
# ---------------------------------------------------------------------
async def upsert_community_space(payload: dict[str, Any]) -> None:
    async with acquire() as conn:
        await conn.execute(
            """
            INSERT INTO community_spaces (
                id, name, slug, url, members_count, posts_count, private, synced_at
            ) VALUES (
                %(id)s, %(name)s, %(slug)s, %(url)s, %(members_count)s,
                %(posts_count)s, %(private)s, now()
            )
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                slug = EXCLUDED.slug,
                url = EXCLUDED.url,
                members_count = EXCLUDED.members_count,
                posts_count = EXCLUDED.posts_count,
                private = EXCLUDED.private,
                synced_at = now()
            """,
            payload,
        )


# ---------------------------------------------------------------------
# posts (Repository implementation)
# ---------------------------------------------------------------------
def _post_row(doc: Document) -> dict[str, Any]:
    """Map a normalized Document to community_posts columns."""
    extra = doc.extra
    return {
        "id": doc.external_id,
        "space_id": doc.container_id,
        "title": doc.title,
        "url": doc.url,
        "replies_count": int(extra.get("replies_count", 0) or 0),
        "reactions_count": int(extra.get("reactions_count", 0) or 0),
        "is_question": bool(extra.get("is_question", False)),
        "has_accepted_answer": bool(extra.get("has_accepted_answer", False)),
        "post_type": extra.get("post_type"),
        "tags": list(extra.get("tags") or []),
        "tag_ids": list(extra.get("tag_ids") or []),
        "author_name": doc.author,
        "status": extra.get("status") or "PUBLISHED",
        "created_at": doc.created_at,
        "updated_at": doc.updated_at,
        "last_activity_at": doc.activity_at,
    }


class CommunityRepository:
    """Repository protocol implementation for community_posts."""

    async def get_hash(self, external_id: str) -> str | None:
        async with acquire() as conn:
            cur = await conn.execute(
                "SELECT body_hash FROM community_posts WHERE id = %s", (external_id,)
            )
            row = cast("dict[str, Any] | None", await cur.fetchone())
            return row["body_hash"] if row else None

    async def get_change_keys(
        self, external_id: str
    ) -> tuple[datetime | None, datetime | None] | None:
        """Stored ``(last_activity_at, updated_at)`` or None if the post is new.

        The orchestrator uses this as a cheap change gate without fetching the
        thread: ``last_activity_at`` bumps when a reply is added, ``updated_at``
        bumps when the post itself is edited. If BOTH match the values from the
        post list, the thread is unchanged and need not be re-fetched/embedded.
        """
        async with acquire() as conn:
            cur = await conn.execute(
                "SELECT last_activity_at, updated_at FROM community_posts WHERE id = %s",
                (external_id,),
            )
            row = cast("dict[str, Any] | None", await cur.fetchone())
            if row is None:
                return None
            return row["last_activity_at"], row["updated_at"]

    async def upsert_full(
        self,
        doc: Document,
        *,
        body_text: str,
        body_hash: str,
        embedding: list[float] | None,
        embedding_model: str | None,
    ) -> None:
        payload = _post_row(doc)
        payload.update(
            {
                "body_html": doc.body_html,
                "body_text": body_text,
                "body_hash": body_hash,
                "embedding": embedding,
                "embedding_model": embedding_model,
            }
        )
        async with acquire() as conn:
            await conn.execute(
                """
                INSERT INTO community_posts (
                    id, space_id, title, url,
                    body_html, body_text, body_hash,
                    embedding, embedding_model,
                    replies_count, reactions_count, is_question, has_accepted_answer,
                    post_type, tags, tag_ids,
                    author_name, status,
                    created_at, updated_at, last_activity_at,
                    synced_at, indexed_at
                ) VALUES (
                    %(id)s, %(space_id)s, %(title)s, %(url)s,
                    %(body_html)s, %(body_text)s, %(body_hash)s,
                    %(embedding)s, %(embedding_model)s,
                    %(replies_count)s, %(reactions_count)s, %(is_question)s,
                    %(has_accepted_answer)s,
                    %(post_type)s, %(tags)s, %(tag_ids)s,
                    %(author_name)s, %(status)s,
                    %(created_at)s, %(updated_at)s, %(last_activity_at)s,
                    now(), now()
                )
                ON CONFLICT (id) DO UPDATE SET
                    space_id = EXCLUDED.space_id,
                    title = EXCLUDED.title,
                    url = EXCLUDED.url,
                    body_html = EXCLUDED.body_html,
                    body_text = EXCLUDED.body_text,
                    body_hash = EXCLUDED.body_hash,
                    embedding = EXCLUDED.embedding,
                    embedding_model = EXCLUDED.embedding_model,
                    replies_count = EXCLUDED.replies_count,
                    reactions_count = EXCLUDED.reactions_count,
                    is_question = EXCLUDED.is_question,
                    has_accepted_answer = EXCLUDED.has_accepted_answer,
                    post_type = EXCLUDED.post_type,
                    tags = EXCLUDED.tags,
                    tag_ids = EXCLUDED.tag_ids,
                    author_name = EXCLUDED.author_name,
                    status = EXCLUDED.status,
                    created_at = EXCLUDED.created_at,
                    updated_at = EXCLUDED.updated_at,
                    last_activity_at = EXCLUDED.last_activity_at,
                    synced_at = now(),
                    indexed_at = now()
                """,
                payload,
            )

    async def upsert_metadata(self, doc: Document, *, body_text: str) -> None:
        """Hash-unchanged path: refresh volatile metadata, leave body/embedding."""
        async with acquire() as conn:
            await conn.execute(
                """
                UPDATE community_posts SET
                    space_id = %(space_id)s,
                    title = %(title)s,
                    url = %(url)s,
                    replies_count = %(replies_count)s,
                    reactions_count = %(reactions_count)s,
                    is_question = %(is_question)s,
                    has_accepted_answer = %(has_accepted_answer)s,
                    post_type = %(post_type)s,
                    tags = %(tags)s,
                    tag_ids = %(tag_ids)s,
                    author_name = %(author_name)s,
                    status = %(status)s,
                    created_at = %(created_at)s,
                    updated_at = %(updated_at)s,
                    last_activity_at = %(last_activity_at)s,
                    synced_at = now()
                WHERE id = %(id)s
                """,
                _post_row(doc),
            )

    async def record_skipped(
        self, doc: Document, *, reason: str, body_len: int
    ) -> None:
        async with acquire() as conn:
            await conn.execute(
                """
                INSERT INTO community_skipped_posts (post_id, title, reason, body_len)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (post_id) DO UPDATE SET
                    title = EXCLUDED.title,
                    reason = EXCLUDED.reason,
                    body_len = EXCLUDED.body_len,
                    skipped_at = now()
                """,
                (doc.external_id, doc.title[:500], reason, body_len),
            )

    async def delete_orphans(self, active_ids: Sequence[str]) -> int:
        active = list(active_ids)
        if not active:
            return 0
        async with acquire() as conn:
            cur = await conn.execute(
                "DELETE FROM community_posts WHERE id <> ALL(%s)", (active,)
            )
            return cur.rowcount


# ---------------------------------------------------------------------
# community_sync_state (separate singleton from the help sync_state)
# ---------------------------------------------------------------------
async def begin_community_sync() -> None:
    async with acquire() as conn:
        await conn.execute(
            """
            UPDATE community_sync_state SET
                last_status = 'running',
                last_error = NULL
            WHERE id = 1
            """
        )


async def finish_community_sync(
    *,
    status: str,
    post_count: int,
    changed_count: int,
    duration_sec: int,
    error: str | None = None,
) -> None:
    error_count_expr = "0" if status == "ok" else "error_count + 1"
    async with acquire() as conn:
        await conn.execute(
            f"""
            UPDATE community_sync_state SET
                last_full_sync_at = now(),
                last_status = %s,
                last_post_count = %s,
                last_changed_count = %s,
                last_duration_sec = %s,
                last_error = %s,
                error_count = {error_count_expr}
            WHERE id = 1
            """,  # noqa: S608 - error_count_expr is a static literal, not user input
            (status, post_count, changed_count, duration_sec, error),
        )


async def get_community_sync_state() -> dict[str, Any] | None:
    async with acquire() as conn:
        cur = await conn.execute("SELECT * FROM community_sync_state WHERE id = 1")
        return cast("dict[str, Any] | None", await cur.fetchone())


__all__: Iterable[str] = (
    "CommunityRepository",
    "begin_community_sync",
    "finish_community_sync",
    "get_community_sync_state",
    "upsert_community_space",
)

"""Shared PostgreSQL access layer for sankhya_ajuda.

Exposes an async connection pool plus upsert helpers used by the ETL today
and by the future MCP server (read paths) tomorrow.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any, cast

import structlog
from pgvector.psycopg import register_vector_async
from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from .config import PgSettings, get_settings

log = structlog.get_logger(__name__)

_pool: AsyncConnectionPool[Any] | None = None


async def _on_connect(conn: AsyncConnection) -> None:
    await register_vector_async(conn)


async def get_pool(settings: PgSettings | None = None) -> AsyncConnectionPool[Any]:
    global _pool  # noqa: PLW0603 — module-level lazy singleton is intentional
    if _pool is None:
        cfg = settings or get_settings().pg
        pool = AsyncConnectionPool(
            conninfo=cfg.dsn,
            min_size=1,
            max_size=4,
            kwargs={"row_factory": dict_row},
            configure=_on_connect,
            open=False,
        )
        await pool.open()
        _pool = pool
        log.info("db.pool_opened", host=cfg.host, db=cfg.db)
    return _pool


async def close_pool() -> None:
    global _pool  # noqa: PLW0603 — module-level lazy singleton is intentional
    if _pool is not None:
        await _pool.close()
        _pool = None


@asynccontextmanager
async def acquire():
    pool = await get_pool()
    async with pool.connection() as conn:
        yield conn


# ---------------------------------------------------------------------
# categories
# ---------------------------------------------------------------------
async def upsert_category(payload: dict[str, Any]) -> None:
    async with acquire() as conn:
        await conn.execute(
            """
            INSERT INTO categories (
                id, name, description, html_url, position, locale,
                created_at_zendesk, updated_at_zendesk, synced_at
            ) VALUES (
                %(id)s, %(name)s, %(description)s, %(html_url)s, %(position)s, %(locale)s,
                %(created_at)s, %(updated_at)s, now()
            )
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                description = EXCLUDED.description,
                html_url = EXCLUDED.html_url,
                position = EXCLUDED.position,
                locale = EXCLUDED.locale,
                created_at_zendesk = EXCLUDED.created_at_zendesk,
                updated_at_zendesk = EXCLUDED.updated_at_zendesk,
                synced_at = now()
            """,
            payload,
        )


# ---------------------------------------------------------------------
# sections
# ---------------------------------------------------------------------
async def upsert_section(payload: dict[str, Any]) -> None:
    """First-pass: upsert section WITHOUT parent_section_id.

    The parent FK is set in a second pass via :func:`update_section_parents`
    so the order of arrival from the API does not matter.
    """
    async with acquire() as conn:
        await conn.execute(
            """
            INSERT INTO sections (
                id, category_id, name, description, html_url, position, locale,
                created_at_zendesk, updated_at_zendesk, synced_at
            ) VALUES (
                %(id)s, %(category_id)s, %(name)s, %(description)s, %(html_url)s,
                %(position)s, %(locale)s, %(created_at)s, %(updated_at)s, now()
            )
            ON CONFLICT (id) DO UPDATE SET
                category_id = EXCLUDED.category_id,
                name = EXCLUDED.name,
                description = EXCLUDED.description,
                html_url = EXCLUDED.html_url,
                position = EXCLUDED.position,
                locale = EXCLUDED.locale,
                created_at_zendesk = EXCLUDED.created_at_zendesk,
                updated_at_zendesk = EXCLUDED.updated_at_zendesk,
                synced_at = now()
            """,
            payload,
        )


async def update_section_parents(parent_map: dict[int, int | None]) -> None:
    """Second-pass: set parent_section_id once every section is in the table."""
    if not parent_map:
        return
    async with acquire() as conn, conn.transaction():
        for section_id, parent_id in parent_map.items():
            await conn.execute(
                "UPDATE sections SET parent_section_id = %s WHERE id = %s",
                (parent_id, section_id),
            )


# ---------------------------------------------------------------------
# articles
# ---------------------------------------------------------------------
async def get_article_hash(article_id: int) -> str | None:
    async with acquire() as conn:
        cur = await conn.execute(
            "SELECT body_hash FROM articles WHERE id = %s",
            (article_id,),
        )
        row = cast("dict[str, Any] | None", await cur.fetchone())
        return row["body_hash"] if row else None


async def upsert_article_metadata(payload: dict[str, Any]) -> None:
    """Update metadata only — body / embedding untouched (hash unchanged path)."""
    async with acquire() as conn:
        await conn.execute(
            """
            UPDATE articles SET
                section_id = %(section_id)s,
                title = %(title)s,
                html_url = %(html_url)s,
                label_names = %(label_names)s,
                content_tag_ids = %(content_tag_ids)s,
                outdated = %(outdated)s,
                author_id = %(author_id)s,
                locale = %(locale)s,
                draft = %(draft)s,
                promoted = %(promoted)s,
                vote_sum = %(vote_sum)s,
                vote_count = %(vote_count)s,
                created_at_zendesk = %(created_at)s,
                updated_at_zendesk = %(updated_at)s,
                edited_at_zendesk = %(edited_at)s,
                synced_at = now()
            WHERE id = %(id)s
            """,
            payload,
        )


async def upsert_article_full(payload: dict[str, Any]) -> None:
    """Full upsert including body, hash, and embedding."""
    async with acquire() as conn:
        await conn.execute(
            """
            INSERT INTO articles (
                id, section_id, title, html_url,
                body_html, body_text, body_hash,
                embedding, embedding_model,
                label_names, content_tag_ids, outdated, author_id,
                locale, draft, promoted,
                vote_sum, vote_count,
                created_at_zendesk, updated_at_zendesk, edited_at_zendesk,
                synced_at, indexed_at
            ) VALUES (
                %(id)s, %(section_id)s, %(title)s, %(html_url)s,
                %(body_html)s, %(body_text)s, %(body_hash)s,
                %(embedding)s, %(embedding_model)s,
                %(label_names)s, %(content_tag_ids)s, %(outdated)s, %(author_id)s,
                %(locale)s, %(draft)s, %(promoted)s,
                %(vote_sum)s, %(vote_count)s,
                %(created_at)s, %(updated_at)s, %(edited_at)s,
                now(), now()
            )
            ON CONFLICT (id) DO UPDATE SET
                section_id = EXCLUDED.section_id,
                title = EXCLUDED.title,
                html_url = EXCLUDED.html_url,
                body_html = EXCLUDED.body_html,
                body_text = EXCLUDED.body_text,
                body_hash = EXCLUDED.body_hash,
                embedding = EXCLUDED.embedding,
                embedding_model = EXCLUDED.embedding_model,
                label_names = EXCLUDED.label_names,
                content_tag_ids = EXCLUDED.content_tag_ids,
                outdated = EXCLUDED.outdated,
                author_id = EXCLUDED.author_id,
                locale = EXCLUDED.locale,
                draft = EXCLUDED.draft,
                promoted = EXCLUDED.promoted,
                vote_sum = EXCLUDED.vote_sum,
                vote_count = EXCLUDED.vote_count,
                created_at_zendesk = EXCLUDED.created_at_zendesk,
                updated_at_zendesk = EXCLUDED.updated_at_zendesk,
                edited_at_zendesk = EXCLUDED.edited_at_zendesk,
                synced_at = now(),
                indexed_at = now()
            """,
            payload,
        )


async def record_skipped_article(
    *, article_id: int, title: str, reason: str, body_len: int
) -> None:
    """Persist an audit row for an article that bypassed the embedding step."""
    async with acquire() as conn:
        await conn.execute(
            """
            INSERT INTO skipped_articles (article_id, title, reason, body_len)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (article_id) DO UPDATE SET
                title = EXCLUDED.title,
                reason = EXCLUDED.reason,
                body_len = EXCLUDED.body_len,
                skipped_at = now()
            """,
            (article_id, title, reason, body_len),
        )


async def delete_orphan_articles(active_ids: Iterable[int]) -> int:
    """Delete articles whose ids are not in the active set; returns count deleted."""
    active = list(active_ids)
    if not active:
        return 0
    async with acquire() as conn:
        cur = await conn.execute(
            "DELETE FROM articles WHERE id <> ALL(%s)",
            (active,),
        )
        return cur.rowcount


# ---------------------------------------------------------------------
# sync_state
# ---------------------------------------------------------------------
async def refresh_breadcrumbs() -> int:
    """Recompute the materialized ``articles.breadcrumb`` column from the
    ``article_breadcrumb`` view. Cheap at ~6k rows; called at the end of each
    sync run so downstream queries never pay the recursive-CTE cost."""
    async with acquire() as conn:
        cur = await conn.execute(
            """
            UPDATE articles a
            SET breadcrumb = b.path
            FROM article_breadcrumb b
            WHERE a.id = b.article_id
              AND (a.breadcrumb IS DISTINCT FROM b.path)
            """
        )
        return cur.rowcount


async def begin_sync() -> None:
    async with acquire() as conn:
        await conn.execute(
            """
            UPDATE sync_state SET
                last_status = 'running',
                last_error = NULL
            WHERE id = 1
            """
        )


async def finish_sync(
    *,
    status: str,
    article_count: int,
    changed_count: int,
    duration_sec: int,
    error: str | None = None,
) -> None:
    # error_count: reset to 0 on success; increment on any non-ok status
    # (error / interrupted). Enables alerting on N consecutive failed cron runs.
    error_count_expr = "0" if status == "ok" else "error_count + 1"
    async with acquire() as conn:
        await conn.execute(
            f"""
            UPDATE sync_state SET
                last_full_sync_at = now(),
                last_status = %s,
                last_article_count = %s,
                last_changed_count = %s,
                last_duration_sec = %s,
                last_error = %s,
                error_count = {error_count_expr}
            WHERE id = 1
            """,  # noqa: S608 - error_count_expr is a static literal, not user input
            (status, article_count, changed_count, duration_sec, error),
        )


async def get_sync_state() -> dict[str, Any] | None:
    async with acquire() as conn:
        cur = await conn.execute("SELECT * FROM sync_state WHERE id = 1")
        return cast("dict[str, Any] | None", await cur.fetchone())


# ---------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------
def parse_zendesk_ts(value: str | None) -> datetime | None:
    """Zendesk returns ISO8601 with 'Z' or offset. psycopg accepts the string;
    we return ``None`` for falsy input so payloads can pass it directly."""
    return None if not value else datetime.fromisoformat(value.replace("Z", "+00:00"))


__all__: Sequence[str] = (
    "acquire",
    "begin_sync",
    "close_pool",
    "delete_orphan_articles",
    "finish_sync",
    "get_article_hash",
    "get_pool",
    "get_sync_state",
    "parse_zendesk_ts",
    "record_skipped_article",
    "refresh_breadcrumbs",
    "update_section_parents",
    "upsert_article_full",
    "upsert_article_metadata",
    "upsert_category",
    "upsert_section",
)

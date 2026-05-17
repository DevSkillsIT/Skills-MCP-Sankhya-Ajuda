"""ETL orchestrator: Zendesk Help Center → PostgreSQL + pgvector.

Run modes:
    --full              full sync (default)
    --category-id N     limit to a single category (used for smoke tests)
    --limit N           cap number of articles processed (debug)
    --dry-run           scrape + parse + hash only, no DB writes, no embeddings
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import signal
import sys
import time
from typing import Any

import structlog

from sankhya_ajuda import db
from sankhya_ajuda.config import get_settings
from sankhya_ajuda.embeddings import EmbeddingClient, EmbeddingError, EmbeddingTooLongError

from . import parser as html_parser
from .zendesk import ZendeskClient

log = structlog.get_logger(__name__)

_PROGRESS_EVERY = 50


def _configure_logging(level: str) -> None:
    logging.basicConfig(
        format="%(message)s",
        level=getattr(logging, level.upper(), logging.INFO),
        stream=sys.stdout,
    )
    structlog.configure(
        processors=[
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.KeyValueRenderer(key_order=["event", "level"]),
        ]
    )


def _build_category_payload(c: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": c["id"],
        "name": c.get("name", ""),
        "description": c.get("description", "") or "",
        "html_url": c.get("html_url", ""),
        "position": c.get("position", 0) or 0,
        "locale": c.get("locale", "pt-br"),
        "created_at": db.parse_zendesk_ts(c.get("created_at")),
        "updated_at": db.parse_zendesk_ts(c.get("updated_at")),
    }


def _build_section_payload(s: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": s["id"],
        "category_id": s["category_id"],
        "name": s.get("name", ""),
        "description": s.get("description", "") or "",
        "html_url": s.get("html_url", ""),
        "position": s.get("position", 0) or 0,
        "locale": s.get("locale", "pt-br"),
        "created_at": db.parse_zendesk_ts(s.get("created_at")),
        "updated_at": db.parse_zendesk_ts(s.get("updated_at")),
    }


def _section_parent(s: dict[str, Any]) -> int | None:
    """Extract parent_section_id from a raw Zendesk section payload."""
    parent = s.get("parent_section_id")
    return int(parent) if parent else None


def _build_article_payload(
    a: dict[str, Any],
    *,
    body_text: str,
    body_hash: str,
    embedding: list[float] | None,
    embedding_model: str | None,
) -> dict[str, Any]:
    raw_tag_ids = a.get("content_tag_ids", []) or []
    return {
        "id": a["id"],
        "section_id": a["section_id"],
        "title": a.get("title", ""),
        "html_url": a.get("html_url", ""),
        "body_html": a.get("body", "") or "",
        "body_text": body_text,
        "body_hash": body_hash,
        "embedding": embedding,
        "embedding_model": embedding_model,
        "label_names": a.get("label_names", []) or [],
        "content_tag_ids": [str(t) for t in raw_tag_ids],
        "outdated": bool(a.get("outdated", False)),
        "author_id": a.get("author_id"),
        "locale": a.get("locale", "pt-br"),
        "draft": bool(a.get("draft", False)),
        "promoted": bool(a.get("promoted", False)),
        "vote_sum": int(a.get("vote_sum", 0) or 0),
        "vote_count": int(a.get("vote_count", 0) or 0),
        "created_at": db.parse_zendesk_ts(a.get("created_at")),
        "updated_at": db.parse_zendesk_ts(a.get("updated_at")),
        "edited_at": db.parse_zendesk_ts(a.get("edited_at")),
    }


class SyncRunner:
    def __init__(
        self,
        *,
        category_id: int | None,
        limit: int | None,
        dry_run: bool,
    ) -> None:
        self.category_id = category_id
        self.limit = limit
        self.dry_run = dry_run
        self.settings = get_settings()
        self.processed = 0
        self.changed = 0
        self.unchanged = 0
        self.skipped_embeddings = 0
        self.active_ids: list[int] = []
        self._stop = asyncio.Event()

    def request_stop(self) -> None:
        log.warning("sync.signal_stop")
        self._stop.set()

    async def run(self) -> int:
        started = time.monotonic()
        if not self.dry_run:
            await db.begin_sync()

        status = "ok"
        error_msg: str | None = None

        try:
            async with ZendeskClient() as zd, EmbeddingClient() as emb:
                await self._sync_categories(zd)
                await self._sync_sections(zd)
                await self._sync_articles(zd, emb)

            if not self.dry_run and self.category_id is None and self.limit is None:
                removed = await db.delete_orphan_articles(self.active_ids)
                log.info("sync.orphans_removed", count=removed)
            if not self.dry_run:
                refreshed = await db.refresh_breadcrumbs()
                log.info("sync.breadcrumbs_refreshed", rows=refreshed)
        except KeyboardInterrupt:
            status = "interrupted"
            error_msg = "SIGINT received"
        except Exception as exc:
            status = "error"
            error_msg = repr(exc)
            log.error("sync.failed", error=error_msg)
            raise
        finally:
            duration = int(time.monotonic() - started)
            if not self.dry_run:
                await db.finish_sync(
                    status=status,
                    article_count=self.processed,
                    changed_count=self.changed,
                    duration_sec=duration,
                    error=error_msg,
                )
                await db.close_pool()
            log.info(
                "sync.done",
                status=status,
                processed=self.processed,
                changed=self.changed,
                unchanged=self.unchanged,
                skipped_embeddings=self.skipped_embeddings,
                duration_sec=duration,
                dry_run=self.dry_run,
            )
        return 0 if status == "ok" else 1

    async def _sync_categories(self, zd: ZendeskClient) -> None:
        cats = await zd.list_categories()
        log.info("sync.categories_fetched", count=len(cats))
        if self.dry_run:
            return
        for c in cats:
            if self.category_id is not None and c["id"] != self.category_id:
                continue
            await db.upsert_category(_build_category_payload(c))

    async def _sync_sections(self, zd: ZendeskClient) -> None:
        sections = await zd.list_sections()
        log.info("sync.sections_fetched", count=len(sections))
        if self.dry_run:
            return
        parent_map: dict[int, int | None] = {}
        for s in sections:
            if (
                self.category_id is not None
                and s.get("category_id") != self.category_id
            ):
                continue
            await db.upsert_section(_build_section_payload(s))
            parent_map[int(s["id"])] = _section_parent(s)
        # Second pass: now every section row exists, link the parents.
        await db.update_section_parents(parent_map)
        nested = sum(1 for v in parent_map.values() if v is not None)
        log.info("sync.section_parents_linked", linked=nested, total=len(parent_map))

    async def _sync_articles(
        self,
        zd: ZendeskClient,
        emb: EmbeddingClient,
    ) -> None:
        async for art in zd.iter_articles(category_id=self.category_id):
            if self._stop.is_set():
                break
            if self.limit is not None and self.processed >= self.limit:
                break

            self.processed += 1
            self.active_ids.append(art["id"])

            clean = html_parser.clean_html(art.get("body", "") or "")
            body_text = html_parser.build_body_text(art.get("title", ""), clean)
            body_hash = html_parser.compute_hash(body_text)

            if self.dry_run:
                self._log_progress(art, body_text, mode="dry")
                continue

            existing_hash = await db.get_article_hash(art["id"])
            if existing_hash == body_hash:
                payload = _build_article_payload(
                    art,
                    body_text=body_text,
                    body_hash=body_hash,
                    embedding=None,
                    embedding_model=None,
                )
                payload.pop("body_html")
                payload.pop("body_text")
                payload.pop("body_hash")
                payload.pop("embedding")
                payload.pop("embedding_model")
                await db.upsert_article_metadata(payload)
                self.unchanged += 1
                self._log_progress(art, body_text, mode="skip")
                continue

            try:
                vector = await emb.embed(body_text)
            except EmbeddingTooLongError as exc:
                # Article body cannot fit in the embedding context even after
                # truncation. Skip the embedding but still keep the article
                # text in PostgreSQL so FTS can find it.
                log.warning(
                    "sync.embed_too_long",
                    article_id=art["id"],
                    body_len=len(body_text),
                    error=str(exc)[:200],
                )
                self.skipped_embeddings += 1
                payload = _build_article_payload(
                    art,
                    body_text=body_text,
                    body_hash=body_hash,
                    embedding=None,
                    embedding_model=None,
                )
                await db.upsert_article_full(payload)
                await db.record_skipped_article(
                    article_id=art["id"],
                    title=art.get("title", "")[:500],
                    reason="context_length_exceeded",
                    body_len=len(body_text),
                )
                self.changed += 1
                self._log_progress(art, body_text, mode="no-embed")
                continue
            except EmbeddingError as exc:
                log.error("sync.embed_failed", article_id=art["id"], error=str(exc))
                raise

            payload = _build_article_payload(
                art,
                body_text=body_text,
                body_hash=body_hash,
                embedding=vector,
                embedding_model=self.settings.vllm.model,
            )
            await db.upsert_article_full(payload)
            self.changed += 1
            self._log_progress(art, body_text, mode="new")

    def _log_progress(
        self, art: dict[str, Any], body_text: str, *, mode: str
    ) -> None:
        if self.processed % _PROGRESS_EVERY == 0 or mode == "new":
            log.info(
                "sync.article",
                processed=self.processed,
                changed=self.changed,
                unchanged=self.unchanged,
                article_id=art["id"],
                title=art.get("title", "")[:80],
                body_len=len(body_text),
                mode=mode,
            )


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Sankhya Help Center ETL")
    p.add_argument("--full", action="store_true", help="full sync (default)")
    p.add_argument("--category-id", type=int, default=None, help="limit to one category")
    p.add_argument("--limit", type=int, default=None, help="max articles to process")
    p.add_argument("--dry-run", action="store_true", help="no DB writes, no embeddings")
    return p.parse_args(argv)


async def _async_main(args: argparse.Namespace) -> int:
    runner = SyncRunner(
        category_id=args.category_id,
        limit=args.limit,
        dry_run=args.dry_run,
    )
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, runner.request_stop)
        except NotImplementedError:
            # Windows: signal handlers not supported
            pass
    return await runner.run()


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    settings = get_settings()
    _configure_logging(settings.sync.log_level)
    log.info(
        "sync.start",
        full=args.full,
        category_id=args.category_id,
        limit=args.limit,
        dry_run=args.dry_run,
    )
    return asyncio.run(_async_main(args))


if __name__ == "__main__":
    raise SystemExit(main())

"""ETL orchestrator: Sankhya community (Bettermode) -> PostgreSQL + pgvector.

Mirrors ``sync/sync.py`` (the help-center ETL) but for the community source:
spaces instead of categories/sections, and Q&A *threads* instead of flat
articles. Each post is composed into a single thread document (question +
replies) and handed to the shared :class:`DocumentIndexer`.

Run modes:
    --full              full sync (default)
    --space-id ID       limit to a single space (smoke tests)
    --limit N           cap number of posts processed (debug)
    --dry-run           scrape + parse only, no DB writes, no embeddings

A cheap change gate compares each post's ``lastActivityAt`` against the stored
value: unchanged threads skip the reply fetch + embedding entirely.
"""

from __future__ import annotations

import argparse
import asyncio
import signal
import time
from typing import Any

import structlog

from sankhya_ajuda import community_db, db
from sankhya_ajuda.community_db import CommunityRepository
from sankhya_ajuda.config import get_settings
from sankhya_ajuda.embeddings import EmbeddingClient
from sankhya_ajuda.indexer import DocumentIndexer
from sankhya_ajuda.sources.base import Document

from . import bettermode
from .bettermode import BettermodeClient

# Reuse the help-center logging setup verbatim — same renderer, same keys.
from .sync import _configure_logging

log = structlog.get_logger(__name__)

_PROGRESS_EVERY = 50

# postType.name values (lowercased) that mark a post as a question.
_QUESTION_TYPES = {"pergunta", "question", "dúvida", "duvida", "q&a"}


class _NullEmbedder:
    """Placeholder used only for the pre-``try`` indexer whose counters start at
    zero; it is replaced by the real client before any document is processed."""

    async def embed(self, text: str) -> list[float]:
        raise RuntimeError("embedder not initialized")


_NULL_EMBEDDER = _NullEmbedder()


def _member_name(node: dict[str, Any]) -> str | None:
    return ((node.get("owner") or {}).get("member") or {}).get("name")


def _compose_thread(node: dict[str, Any], replies: list[dict[str, Any]]) -> Document:
    """Build a single normalized Document from a post node and its replies.

    The indexed body is the whole thread (question first, then each reply with
    its author), so semantic search can surface a post whose answer lives in a
    reply. The HTML is left raw — the indexer cleans and hashes it.
    """
    content = bettermode.field_value(node, "content") or ""
    parts = [content]
    for reply in replies:
        reply_content = bettermode.field_value(reply, "content") or ""
        if not reply_content:
            continue
        author = _member_name(reply) or "Membro"
        # _depth > 0 marks a nested reply (reply-to-reply) so the thread shape
        # survives in the indexed text.
        label = "Resposta aninhada" if reply.get("_depth", 0) > 0 else "Resposta"
        parts.append(f"<p><strong>{label} de {author}:</strong></p>{reply_content}")
    body_html = "\n".join(p for p in parts if p)

    post_type_name = (node.get("postType") or {}).get("name")
    tags = [t["title"] for t in (node.get("tags") or []) if t.get("title")]
    return Document(
        source="community",
        external_id=node["id"],
        title=node.get("title", "") or "",
        body_html=body_html,
        url=node.get("url", "") or "",
        container_id=(node.get("space") or {}).get("id"),
        author=_member_name(node),
        created_at=db.parse_zendesk_ts(node.get("createdAt")),
        updated_at=db.parse_zendesk_ts(node.get("updatedAt")),
        activity_at=db.parse_zendesk_ts(node.get("lastActivityAt")),
        extra={
            "replies_count": node.get("totalRepliesCount", 0) or 0,
            "reactions_count": node.get("reactionsCount", 0) or 0,
            "is_question": (post_type_name or "").strip().lower() in _QUESTION_TYPES,
            # A pinned reply is Bettermode's "highlighted/accepted answer" signal.
            "has_accepted_answer": bool(node.get("pinnedReplies")),
            "post_type": post_type_name,
            "tags": tags,
            "tag_ids": node.get("tagIds") or [],
            "status": node.get("status") or "PUBLISHED",
        },
    )


class CommunitySyncRunner:
    def __init__(self, *, space_id: str | None, limit: int | None, dry_run: bool) -> None:
        self.space_id = space_id
        self.limit = limit
        self.dry_run = dry_run
        self.settings = get_settings()
        self.repo = CommunityRepository()

        self.processed = 0
        self.unchanged_activity = 0
        self.skipped_no_space = 0
        self.skipped_hidden = 0
        self.public_spaces = 0
        self.private_spaces = 0
        self.active_ids: list[str] = []
        self._stop = asyncio.Event()

    def request_stop(self) -> None:
        log.warning("community_sync.signal_stop")
        self._stop.set()

    async def run(self) -> int:
        started = time.monotonic()
        if not self.dry_run:
            await community_db.begin_community_sync()

        status = "ok"
        error_msg: str | None = None
        # Counters live on the indexer; create it before the try so the finally
        # block can always read them even if setup fails.
        indexer = DocumentIndexer(
            repo=self.repo,
            embedder=_NULL_EMBEDDER,
            embedding_model=self.settings.vllm.model,
            dry_run=self.dry_run,
        )

        try:
            async with BettermodeClient() as client, EmbeddingClient() as emb:
                indexer = DocumentIndexer(
                    repo=self.repo,
                    embedder=emb,
                    embedding_model=self.settings.vllm.model,
                    dry_run=self.dry_run,
                )
                await self._sync_spaces(client)
                await self._sync_posts(client, indexer)

            if not self.dry_run and self.space_id is None and self.limit is None:
                removed = await self.repo.delete_orphans(self.active_ids)
                log.info("community_sync.orphans_removed", count=removed)
        except KeyboardInterrupt:
            status = "interrupted"
            error_msg = "SIGINT received"
        except Exception as exc:
            status = "error"
            error_msg = repr(exc)
            log.error("community_sync.failed", error=error_msg)
            raise
        finally:
            duration = int(time.monotonic() - started)
            if not self.dry_run:
                await community_db.finish_community_sync(
                    status=status,
                    post_count=self.processed,
                    changed_count=indexer.changed,
                    duration_sec=duration,
                    error=error_msg,
                )
                await db.close_pool()
            log.info(
                "community_sync.done",
                status=status,
                processed=self.processed,
                changed=indexer.changed,
                unchanged=self.unchanged_activity + indexer.unchanged,
                skipped_embeddings=indexer.skipped_embeddings,
                skipped_no_space=self.skipped_no_space,
                skipped_hidden=self.skipped_hidden,
                public_spaces=self.public_spaces,
                private_spaces=self.private_spaces,
                duration_sec=duration,
                dry_run=self.dry_run,
            )
        return 0 if status == "ok" else 1

    async def _sync_spaces(self, client: BettermodeClient) -> None:
        async for sp in client.iter_spaces():
            if sp.get("private"):
                self.private_spaces += 1
                continue
            self.public_spaces += 1
            if self.dry_run:
                continue
            await community_db.upsert_community_space(
                {
                    "id": sp["id"],
                    "name": sp.get("name", "") or "",
                    "slug": sp.get("slug", "") or "",
                    "url": sp.get("url", "") or "",
                    "members_count": sp.get("membersCount", 0) or 0,
                    "posts_count": sp.get("postsCount", 0) or 0,
                    "private": False,
                }
            )
        log.info(
            "community_sync.spaces_synced",
            public=self.public_spaces,
            private=self.private_spaces,
        )

    async def _sync_posts(
        self, client: BettermodeClient, indexer: DocumentIndexer
    ) -> None:
        async for node in client.iter_posts():
            if self._stop.is_set():
                break
            if self.limit is not None and self.processed >= self.limit:
                break
            node_space_id = (node.get("space") or {}).get("id")
            if self.space_id is not None and node_space_id != self.space_id:
                continue
            # community_posts.space_id is NOT NULL + FK; a post without a space
            # (should not happen for public posts) would abort the whole sync on
            # FK violation, so skip it defensively and keep going.
            if not node_space_id:
                self.skipped_no_space += 1
                log.warning("community_sync.post_without_space", post_id=node.get("id"))
                continue
            # Hidden posts were pulled from public view by moderation; keep them
            # out of the searchable index.
            if node.get("isHidden"):
                self.skipped_hidden += 1
                continue

            post_id = node["id"]
            self.processed += 1
            self.active_ids.append(post_id)

            if self.dry_run:
                await indexer.index(_compose_thread(node, []))
                self._log_progress(node, mode="dry")
                continue

            # Cheap change gate: skip the reply fetch + embedding when neither the
            # thread activity (new reply) nor the post itself (edit) changed.
            node_keys = (
                db.parse_zendesk_ts(node.get("lastActivityAt")),
                db.parse_zendesk_ts(node.get("updatedAt")),
            )
            stored_keys = await self.repo.get_change_keys(post_id)
            if stored_keys is not None and stored_keys == node_keys:
                await self.repo.upsert_metadata(
                    _compose_thread(node, []), body_text=""
                )
                self.unchanged_activity += 1
                self._log_progress(node, mode="skip-unchanged")
                continue

            replies: list[dict[str, Any]] = []
            if (node.get("totalRepliesCount") or 0) > 0:
                replies = await client.fetch_replies(post_id)
            mode = await indexer.index(_compose_thread(node, replies))
            self._log_progress(node, mode=mode)

    def _log_progress(self, node: dict[str, Any], *, mode: str) -> None:
        if self.processed % _PROGRESS_EVERY == 0 or mode == "new":
            log.info(
                "community_sync.post",
                processed=self.processed,
                post_id=node.get("id"),
                title=(node.get("title", "") or "")[:80],
                replies=node.get("totalRepliesCount", 0),
                mode=mode,
            )


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Sankhya Community (Bettermode) ETL")
    p.add_argument("--full", action="store_true", help="full sync (default)")
    p.add_argument("--space-id", type=str, default=None, help="limit to one space")
    p.add_argument("--limit", type=int, default=None, help="max posts to process")
    p.add_argument("--dry-run", action="store_true", help="no DB writes, no embeddings")
    return p.parse_args(argv)


async def _async_main(args: argparse.Namespace) -> int:
    runner = CommunitySyncRunner(
        space_id=args.space_id, limit=args.limit, dry_run=args.dry_run
    )
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, runner.request_stop)
        except NotImplementedError:
            pass  # Windows: signal handlers not supported
    return await runner.run()


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    settings = get_settings()
    _configure_logging(settings.sync.log_level)
    log.info(
        "community_sync.start",
        full=args.full,
        space_id=args.space_id,
        limit=args.limit,
        dry_run=args.dry_run,
    )
    return asyncio.run(_async_main(args))


if __name__ == "__main__":
    raise SystemExit(main())

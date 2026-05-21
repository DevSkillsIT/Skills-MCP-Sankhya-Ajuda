"""Generic clean -> hash -> gate -> embed -> upsert loop.

This is the heart of the help-center ``SyncRunner`` lifted into a source-
agnostic component. A :class:`~sankhya_ajuda.sources.base.ContentSource`
produces :class:`Document` objects; a
:class:`~sankhya_ajuda.sources.base.Repository` persists them; this indexer
runs the per-document decision logic and tracks counters.

The behaviour intentionally matches ``sync/sync.py`` exactly:
- unchanged (hash match) -> metadata-only upsert, no embedding
- changed/new            -> embed + full upsert
- body too long          -> keep the text (FTS still finds it), skip embedding
"""

from __future__ import annotations

from typing import Protocol

import structlog

# Pure HTML helpers shared with the help-center ETL — reused, not reimplemented.
from sync import parser as html_parser

from .embeddings import EmbeddingError, EmbeddingTooLongError
from .sources.base import Document, Repository

log = structlog.get_logger(__name__)


class _Embedder(Protocol):
    """Structural type: anything exposing ``async embed(text) -> list[float]``."""

    async def embed(self, text: str) -> list[float]: ...


class DocumentIndexer:
    """Indexes one document at a time, mirroring the help-center sync logic."""

    def __init__(
        self,
        *,
        repo: Repository,
        embedder: _Embedder,
        embedding_model: str,
        dry_run: bool = False,
    ) -> None:
        self._repo = repo
        self._embedder = embedder
        self._embedding_model = embedding_model
        self._dry_run = dry_run

        # Counters scoped to documents this indexer was actually given. Iteration
        # bookkeeping (total seen, active id set) is the orchestrator's job, since
        # it may short-circuit documents before they ever reach the indexer.
        self.changed = 0
        self.unchanged = 0
        self.skipped_embeddings = 0

    async def index(self, doc: Document) -> str:
        """Process a single document. Returns the mode taken for logging.

        Modes: ``dry`` | ``unchanged`` | ``no-embed`` | ``new``.
        """
        clean = html_parser.clean_html(doc.body_html)
        body_text = html_parser.build_body_text(doc.title, clean)
        body_hash = html_parser.compute_hash(body_text)

        if self._dry_run:
            return "dry"

        existing_hash = await self._repo.get_hash(doc.external_id)
        if existing_hash == body_hash:
            await self._repo.upsert_metadata(doc, body_text=body_text)
            self.unchanged += 1
            return "unchanged"

        try:
            vector = await self._embedder.embed(body_text)
        except EmbeddingTooLongError as exc:
            # Body cannot fit the embedding context even after truncation. Keep
            # the text in PostgreSQL so FTS still finds it; skip the vector.
            log.warning(
                "indexer.embed_too_long",
                source=doc.source,
                external_id=doc.external_id,
                body_len=len(body_text),
                error=str(exc)[:200],
            )
            self.skipped_embeddings += 1
            await self._repo.upsert_full(
                doc,
                body_text=body_text,
                body_hash=body_hash,
                embedding=None,
                embedding_model=None,
            )
            await self._repo.record_skipped(
                doc, reason="context_length_exceeded", body_len=len(body_text)
            )
            self.changed += 1
            return "no-embed"
        except EmbeddingError as exc:
            log.error(
                "indexer.embed_failed",
                source=doc.source,
                external_id=doc.external_id,
                error=str(exc),
            )
            raise

        await self._repo.upsert_full(
            doc,
            body_text=body_text,
            body_hash=body_hash,
            embedding=vector,
            embedding_model=self._embedding_model,
        )
        self.changed += 1
        return "new"

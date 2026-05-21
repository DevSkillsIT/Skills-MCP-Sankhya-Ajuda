"""Source-agnostic contracts: the normalized Document and the Protocols a
content source and its repository must satisfy.

This layer exists on purpose: the goal is to index *several* public Sankhya
sources through one ingestion pipeline. Two are known today and more are on the
roadmap:

    - Help center  — Zendesk REST, BIGINT ids, flat articles      (live)
    - Community    — Bettermode GraphQL, alphanumeric ids, Q&A     (this work)
    - Candidates   — Universidade Sankhya, Developers portal, status page, ...

Every source reduces to the same unit of work: a :class:`Document` with HTML
that must be cleaned, hashed, embedded and upserted by
:class:`~sankhya_ajuda.indexer.DocumentIndexer`. Identifiers are kept as ``str``
so both id shapes flow through unchanged.

The abstraction is "earned" once a second implementation adopts it (e.g. a
future Zendesk retrofit); until then the community source is its only client and
the contract is a well-informed bet shaped by reading both real systems.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol, runtime_checkable


@dataclass(slots=True)
class Document:
    """A normalized, source-independent unit to index.

    ``body_html`` is the raw HTML (article body, or a whole Q&A thread). It is
    cleaned and hashed by the indexer; the source must not pre-clean it so the
    hash stays stable across runs. ``extra`` carries source-specific metadata
    (votes, reply counts, accepted-answer flag, ...) that the repository maps to
    its own columns.
    """

    source: str
    external_id: str
    title: str
    body_html: str
    url: str
    container_id: str | None = None
    author: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    # Last activity timestamp (e.g. a new reply); used as a cheap change gate.
    activity_at: datetime | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@runtime_checkable
class ContentSource(Protocol):
    """Yields normalized documents from an external system."""

    name: str

    async def sync_taxonomy(self) -> None:
        """Persist the source's containers (categories/spaces) before documents."""
        ...

    def iter_documents(self) -> AsyncIterator[Document]:
        """Yield every indexable document, one by one."""
        ...


class Repository(Protocol):
    """Persistence for one source. Mirrors the help center's db helpers but
    keyed by ``str`` external ids so it works for both id shapes."""

    async def get_hash(self, external_id: str) -> str | None: ...

    async def upsert_full(
        self,
        doc: Document,
        *,
        body_text: str,
        body_hash: str,
        embedding: list[float] | None,
        embedding_model: str | None,
    ) -> None: ...

    async def upsert_metadata(self, doc: Document, *, body_text: str) -> None: ...

    async def record_skipped(
        self, doc: Document, *, reason: str, body_len: int
    ) -> None: ...

    async def delete_orphans(self, active_ids: Sequence[str]) -> int: ...

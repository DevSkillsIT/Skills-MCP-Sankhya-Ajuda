"""vLLM embedding client (OpenAI-compatible).

Targets a Qwen3-embedding-4b deployment configured via ``VLLM_BASE_URL``
(no hardcoded URL — set in ``.env``). Handles authentication, retries with
exponential backoff, and dimension checks.
"""

from __future__ import annotations

import asyncio
import secrets
from collections.abc import Sequence

import httpx
import structlog

from .config import VllmSettings, get_settings

log = structlog.get_logger(__name__)

_HTTP_TOO_MANY = 429
_HTTP_CLIENT_ERROR_MIN = 400
_HTTP_SERVER_ERROR_MIN = 500

# Qwen3-embedding-4b ceiling is 4096 input tokens. Empirically in PT-BR the
# tokens-per-char ratio reaches ~0.34 for technical text with brand names and
# acronyms, so 8000 chars is a conservative ceiling that stays under 4096 tokens
# with margin for safety. Truncation happens only at the embedding boundary —
# the full body_text remains in PostgreSQL for FTS, retrieval, and re-embedding
# if a larger-context model is adopted later.
_MAX_EMBED_CHARS = 8000


class EmbeddingError(RuntimeError):
    """Raised when the embedding endpoint fails permanently."""


class EmbeddingTooLongError(EmbeddingError):
    """Input exceeds the model context length even after truncation.

    Distinct from generic ``EmbeddingError`` so callers can choose to skip the
    offending record rather than aborting an entire batch.
    """


class EmbeddingClient:
    """Async wrapper around the vLLM /v1/embeddings endpoint."""

    _MAX_ATTEMPTS = 3
    _BACKOFF_BASE = 1.5

    def __init__(self, settings: VllmSettings | None = None) -> None:
        self._cfg = settings or get_settings().vllm
        headers: dict[str, str] = {"Content-Type": "application/json"}
        api_key = self._cfg.api_key.get_secret_value()
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        self._client = httpx.AsyncClient(
            base_url=self._cfg.base_url.rstrip("/"),
            timeout=self._cfg.timeout,
            headers=headers,
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> EmbeddingClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    async def embed(self, text: str) -> list[float]:
        """Embed a single string. Convenience over :meth:`embed_batch`."""
        result = await self.embed_batch([text])
        return result[0]

    async def embed_batch(self, texts: Sequence[str]) -> list[list[float]]:
        if not texts:
            return []
        truncated_inputs = [self._truncate(t) for t in texts]
        payload = {"model": self._cfg.model, "input": truncated_inputs}
        last_error: Exception | None = None

        for attempt in range(1, self._MAX_ATTEMPTS + 1):
            try:
                resp = await self._client.post("/embeddings", json=payload)
            except httpx.RequestError as exc:
                # Network / timeout — retriable.
                last_error = exc
                if not self._should_retry(attempt, str(exc)):
                    break
                await self._sleep_backoff(attempt)
                continue

            status = resp.status_code
            retriable_status = status >= _HTTP_SERVER_ERROR_MIN or status == _HTTP_TOO_MANY
            if retriable_status:
                last_error = httpx.HTTPStatusError(
                    f"vLLM returned {status}", request=resp.request, response=resp
                )
                if not self._should_retry(attempt, f"HTTP {status}"):
                    break
                await self._sleep_backoff(attempt)
                continue

            if status >= _HTTP_CLIENT_ERROR_MIN:
                # Client error (4xx other than 429): not retriable.
                snippet = resp.text[:200]
                if "maximum context length" in resp.text:
                    raise EmbeddingTooLongError(
                        f"vLLM context-length exceeded: {snippet}"
                    )
                raise EmbeddingError(f"vLLM client error {status}: {snippet}")

            try:
                data = resp.json()
                vectors = [item["embedding"] for item in data["data"]]
            except (KeyError, ValueError) as exc:
                raise EmbeddingError(f"malformed vLLM response: {exc}") from exc

            self._validate_dims(vectors)
            log.debug(
                "embeddings.ok",
                count=len(vectors),
                tokens=data.get("usage", {}).get("total_tokens"),
                model=self._cfg.model,
            )
            return vectors

        raise EmbeddingError(
            f"vLLM embedding failed after {self._MAX_ATTEMPTS} attempts: {last_error}"
        ) from last_error

    def _should_retry(self, attempt: int, reason: str) -> bool:
        if attempt >= self._MAX_ATTEMPTS:
            return False
        log.warning("embeddings.retry", attempt=attempt, error=reason)
        return True

    async def _sleep_backoff(self, attempt: int) -> None:
        # Full-jitter exponential backoff:
        # delay = base^attempt + uniform(0, base^attempt / 2)
        # Spreads retries when many clients hit the same outage.
        base_delay = self._BACKOFF_BASE**attempt
        jitter = secrets.SystemRandom().uniform(0.0, base_delay / 2)
        await asyncio.sleep(base_delay + jitter)

    def _truncate(self, text: str) -> str:
        if len(text) <= _MAX_EMBED_CHARS:
            return text
        log.debug(
            "embeddings.truncated",
            original_chars=len(text),
            truncated_chars=_MAX_EMBED_CHARS,
        )
        return text[:_MAX_EMBED_CHARS]

    def _validate_dims(self, vectors: list[list[float]]) -> None:
        expected = self._cfg.dimensions
        for v in vectors:
            if len(v) != expected:
                raise EmbeddingError(
                    f"unexpected embedding dimension: got {len(v)}, expected {expected}"
                )

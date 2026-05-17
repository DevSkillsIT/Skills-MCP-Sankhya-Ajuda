"""Tests for src/sankhya_ajuda/embeddings.py."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from pydantic import SecretStr

from sankhya_ajuda.config import VllmSettings
from sankhya_ajuda.embeddings import EmbeddingClient, EmbeddingError


def _settings(api_key: str = "test-key") -> VllmSettings:
    return VllmSettings(
        base_url="http://test.local/v1",
        api_key=SecretStr(api_key),
        model="/model",
        dimensions=3,
        timeout=1.0,
    )


def _fake_response(
    status: int = 200,
    payload: dict[str, Any] | None = None,
) -> httpx.Response:
    if payload is None:
        payload = {
            "data": [{"embedding": [0.1, 0.2, 0.3]}],
            "usage": {"total_tokens": 5},
        }
    return httpx.Response(
        status_code=status,
        json=payload,
        request=httpx.Request("POST", "http://test.local/v1/embeddings"),
    )


@pytest.mark.asyncio
async def test_embed_single_returns_vector() -> None:
    client = EmbeddingClient(settings=_settings())
    with patch.object(client._client, "post", new=AsyncMock(return_value=_fake_response())):
        result = await client.embed("hello")
    await client.close()
    assert result == [0.1, 0.2, 0.3]


@pytest.mark.asyncio
async def test_empty_batch_returns_empty() -> None:
    client = EmbeddingClient(settings=_settings())
    result = await client.embed_batch([])
    await client.close()
    assert result == []


@pytest.mark.asyncio
async def test_bearer_header_set_when_key_present() -> None:
    client = EmbeddingClient(settings=_settings("secret"))
    assert client._client.headers["Authorization"] == "Bearer secret"
    await client.close()


@pytest.mark.asyncio
async def test_no_auth_header_when_key_empty() -> None:
    client = EmbeddingClient(settings=_settings(""))
    assert "Authorization" not in client._client.headers
    await client.close()


@pytest.mark.asyncio
async def test_dim_mismatch_raises() -> None:
    client = EmbeddingClient(settings=_settings())
    bad = _fake_response(payload={"data": [{"embedding": [0.1, 0.2]}], "usage": {}})
    with patch.object(client._client, "post", new=AsyncMock(return_value=bad)):
        with pytest.raises(EmbeddingError, match="dimension"):
            await client.embed("x")
    await client.close()


@pytest.mark.asyncio
async def test_retries_on_5xx_then_succeeds() -> None:
    client = EmbeddingClient(settings=_settings())
    responses = [_fake_response(status=503), _fake_response()]
    mock = AsyncMock(side_effect=responses)
    with patch.object(client._client, "post", new=mock), patch(
        "sankhya_ajuda.embeddings.asyncio.sleep", new=AsyncMock()
    ):
        result = await client.embed("retry-please")
    await client.close()
    assert result == [0.1, 0.2, 0.3]
    assert mock.await_count == 2


@pytest.mark.asyncio
async def test_gives_up_after_max_attempts() -> None:
    client = EmbeddingClient(settings=_settings())
    mock = AsyncMock(side_effect=[_fake_response(status=503)] * 5)
    with patch.object(client._client, "post", new=mock), patch(
        "sankhya_ajuda.embeddings.asyncio.sleep", new=AsyncMock()
    ):
        with pytest.raises(EmbeddingError, match="failed after"):
            await client.embed("nope")
    await client.close()
    assert mock.await_count == EmbeddingClient._MAX_ATTEMPTS


@pytest.mark.asyncio
async def test_truncates_long_input() -> None:
    """Inputs longer than the embedding ceiling are clipped before send."""
    client = EmbeddingClient(settings=_settings())
    captured: dict[str, object] = {}

    async def capture(*args: object, **kwargs: object) -> httpx.Response:
        captured["json"] = kwargs.get("json")
        return _fake_response()

    long_text = "x" * 50_000
    with patch.object(client._client, "post", new=AsyncMock(side_effect=capture)):
        await client.embed(long_text)
    await client.close()
    payload = captured["json"]
    assert isinstance(payload, dict)
    sent = payload["input"][0]
    assert len(sent) < 50_000  # was truncated
    assert len(sent) <= 12_000


@pytest.mark.asyncio
async def test_4xx_does_not_retry() -> None:
    client = EmbeddingClient(settings=_settings())
    bad = httpx.Response(
        status_code=401,
        json={"error": "Unauthorized"},
        request=httpx.Request("POST", "http://test.local/v1/embeddings"),
    )
    mock = AsyncMock(return_value=bad)
    with patch.object(client._client, "post", new=mock), patch(
        "sankhya_ajuda.embeddings.asyncio.sleep", new=AsyncMock()
    ):
        with pytest.raises(EmbeddingError):
            await client.embed("auth-error")
    await client.close()
    # 401 is not retriable in our policy (only 5xx and 429).
    assert mock.await_count == 1

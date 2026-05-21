"""Unit tests for the Bettermode GraphQL client (hermetic, no network).

Covers the pure helpers (field decoding, JWT expiry) and the stateful bits
that are easy to get wrong: guest-token caching/refresh and cursor pagination.
"""

from __future__ import annotations

import base64
import json
import time
from typing import Any

import pytest

from sankhya_ajuda.config import BettermodeSettings
from sync import bettermode
from sync.bettermode import BettermodeClient, BettermodeError, field_value


# ----------------------------- pure helpers -----------------------------
def test_field_value_decodes_json_encoded_string() -> None:
    node = {"fields": [{"key": "content", "value": '"<p>oi</p>"'}]}
    assert field_value(node, "content") == "<p>oi</p>"


def test_field_value_handles_null_and_missing() -> None:
    node = {"fields": [{"key": "status", "value": "null"}]}
    assert field_value(node, "status") is None
    assert field_value(node, "absent") is None
    assert field_value({}, "anything") is None


def test_field_value_falls_back_to_raw_on_bad_json() -> None:
    node = {"fields": [{"key": "x", "value": "not-json"}]}
    assert field_value(node, "x") == "not-json"


def _make_jwt(exp: int) -> str:
    payload = base64.urlsafe_b64encode(json.dumps({"exp": exp}).encode()).decode()
    return f"header.{payload}.sig"


def test_jwt_exp_reads_expiry() -> None:
    assert bettermode._jwt_exp(_make_jwt(1779405788)) == 1779405788


def test_jwt_exp_malformed_returns_zero() -> None:
    assert bettermode._jwt_exp("not-a-jwt") == 0
    assert bettermode._jwt_exp("") == 0


# ----------------------------- token lifecycle -----------------------------
@pytest.fixture
def client() -> BettermodeClient:
    return BettermodeClient(BettermodeSettings(token_refresh_margin=300))


@pytest.mark.asyncio
async def test_token_fetched_once_then_reused(
    client: BettermodeClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = {"n": 0}
    future_exp = int(time.time()) + 10_000

    async def fake_request(payload: dict[str, Any], *, auth: bool) -> dict[str, Any]:
        if "tokens" in payload["query"]:
            calls["n"] += 1
            return {"tokens": {"accessToken": _make_jwt(future_exp)}}
        return {}

    monkeypatch.setattr(client, "_request", fake_request)

    t1 = await client._ensure_token()
    t2 = await client._ensure_token()
    assert t1 == t2
    assert calls["n"] == 1  # cached on the second call


@pytest.mark.asyncio
async def test_token_refreshed_when_near_expiry(
    client: BettermodeClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = {"n": 0}
    # exp already within the refresh margin -> must refetch every time.
    near_exp = int(time.time()) + 100

    async def fake_request(payload: dict[str, Any], *, auth: bool) -> dict[str, Any]:
        calls["n"] += 1
        return {"tokens": {"accessToken": _make_jwt(near_exp)}}

    monkeypatch.setattr(client, "_request", fake_request)

    await client._ensure_token()
    await client._ensure_token()
    assert calls["n"] == 2


@pytest.mark.asyncio
async def test_missing_token_raises(
    client: BettermodeClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_request(payload: dict[str, Any], *, auth: bool) -> dict[str, Any]:
        return {"tokens": {}}

    monkeypatch.setattr(client, "_request", fake_request)
    with pytest.raises(BettermodeError):
        await client._ensure_token()


# ----------------------------- pagination -----------------------------
@pytest.mark.asyncio
async def test_paginate_follows_cursor_until_exhausted(
    client: BettermodeClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    pages = [
        {
            "spaces": {
                "pageInfo": {"endCursor": "c1", "hasNextPage": True},
                "edges": [{"node": {"id": "a"}}, {"node": {"id": "b"}}],
            }
        },
        {
            "spaces": {
                "pageInfo": {"endCursor": None, "hasNextPage": False},
                "edges": [{"node": {"id": "c"}}],
            }
        },
    ]
    seen_cursors: list[str | None] = []

    async def fake_request(payload: dict[str, Any], *, auth: bool) -> dict[str, Any]:
        seen_cursors.append(payload["variables"]["a"])
        return pages.pop(0)

    monkeypatch.setattr(client, "_request", fake_request)

    out = [n async for n in client.iter_spaces()]
    assert [n["id"] for n in out] == ["a", "b", "c"]
    # First call has no cursor; second uses the cursor returned by page 1.
    assert seen_cursors == [None, "c1"]


@pytest.mark.asyncio
async def test_fetch_replies_respects_cap(
    client: BettermodeClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(bettermode, "_MAX_REPLIES_PER_POST", 2)

    async def fake_request(payload: dict[str, Any], *, auth: bool) -> dict[str, Any]:
        return {
            "replies": {
                "pageInfo": {"endCursor": "x", "hasNextPage": True},
                "edges": [
                    {"node": {"id": "r1"}},
                    {"node": {"id": "r2"}},
                    {"node": {"id": "r3"}},
                ],
            }
        }

    monkeypatch.setattr(client, "_request", fake_request)
    replies = await client.fetch_replies("post-1")
    assert len(replies) == 2  # capped, did not run away on hasNextPage


@pytest.mark.asyncio
async def test_fetch_replies_recurses_into_nested(
    client: BettermodeClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # P -> R1 (has 1 nested) -> R2. Whole tree must come back, depth-tagged.
    children = {
        "P": [{"id": "R1", "totalRepliesCount": 1}],
        "R1": [{"id": "R2", "totalRepliesCount": 0}],
    }

    async def fake_request(payload: dict[str, Any], *, auth: bool) -> dict[str, Any]:
        pid = payload["variables"]["p"]
        edges = [{"node": n} for n in children.get(pid, [])]
        return {
            "replies": {
                "pageInfo": {"endCursor": None, "hasNextPage": False},
                "edges": edges,
            }
        }

    monkeypatch.setattr(client, "_request", fake_request)
    out = await client.fetch_replies("P")
    assert [n["id"] for n in out] == ["R1", "R2"]
    assert out[0]["_depth"] == 0
    assert out[1]["_depth"] == 1  # nested reply tagged one level deeper

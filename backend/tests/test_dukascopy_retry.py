"""Dukascopy downloads must survive rate limiting and never drop hours silently."""
import asyncio
from datetime import datetime

import httpx
import pytest

from app.data import dukascopy


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    real_sleep = asyncio.sleep

    async def fast(_seconds, *a, **k):
        await real_sleep(0)

    monkeypatch.setattr(dukascopy.asyncio, "sleep", fast)


def _client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_rate_limited_hour_is_retried_until_it_succeeds():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        if calls["n"] < 3:
            return httpx.Response(429, headers={"Retry-After": "0.01"})
        return httpx.Response(200, content=b"DATA")

    async def go():
        async with _client(handler) as c:
            return await dukascopy._fetch_hour(c, "XAUUSD", datetime(2024, 1, 2, 5))

    assert asyncio.run(go()) == b"DATA"
    assert calls["n"] == 3


def test_missing_hour_is_not_a_failure_but_errors_are():
    async def go(status):
        async with _client(lambda r: httpx.Response(status)) as c:
            return await dukascopy._fetch_hour(c, "XAUUSD", datetime(2024, 1, 2, 5))

    assert asyncio.run(go(404)) == b""  # weekend / holiday: genuinely no data
    with pytest.raises(dukascopy._HourFailed):
        asyncio.run(go(500))


def _patch_client(monkeypatch, handler):
    real = httpx.AsyncClient

    def factory(*a, **k):
        k["transport"] = httpx.MockTransport(handler)
        return real(*a, **k)

    monkeypatch.setattr(dukascopy.httpx, "AsyncClient", factory)


def test_failed_hours_are_reported(monkeypatch):
    def handler(request):
        hour = int(request.url.path.rsplit("/", 1)[1][:2])
        return httpx.Response(500 if hour in (3, 7) else 404)

    _patch_client(monkeypatch, handler)
    failed: list = []
    rows = asyncio.run(dukascopy.download_m1_range("XAUUSD", datetime(2024, 1, 2), datetime(2024, 1, 2, 12), 0.01, failed=failed))
    assert rows == []
    assert sorted(h.hour for h in failed) == [3, 7]


def test_gives_up_with_a_clear_error_when_nothing_gets_through(monkeypatch):
    _patch_client(monkeypatch, lambda r: httpx.Response(429))
    with pytest.raises(dukascopy.DukascopyError, match="Could not reach Dukascopy"):
        asyncio.run(dukascopy.download_m1_range("XAUUSD", datetime(2024, 1, 2), datetime(2024, 1, 4), 0.01, failed=[]))

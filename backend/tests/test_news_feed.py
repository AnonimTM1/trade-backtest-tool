"""Weekly ForexFactory JSON feed: parsing, UTC conversion, merge with the CSV, rate limiting."""
import io
import json
import time

import pandas as pd
import pytest

from app.data import news, news_feed

FEED = [
    # 08:30 New York in winter = 13:30 UTC
    {"title": "Non-Farm Employment Change", "country": "USD", "date": "2024-01-05T08:30:00-05:00", "impact": "High", "forecast": "168K", "previous": "173K"},
    {"title": "German Factory Orders", "country": "EUR", "date": "2024-01-05T02:00:00-05:00", "impact": "Medium", "forecast": "0.5%", "previous": "0.2%"},
    {"title": "Bank Holiday", "country": "JPY", "date": "2024-01-08T00:00:00-05:00", "impact": "Holiday", "forecast": "", "previous": ""},
    {"title": "G20 Meetings", "country": "All", "date": "2024-01-09T03:00:00-05:00", "impact": "Low", "forecast": "", "previous": ""},
]


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture
def feed(monkeypatch, tmp_path):
    monkeypatch.setattr(news_feed, "ARCHIVE", tmp_path / "ff_feed_archive.json")
    monkeypatch.setattr(news_feed, "_df_cache", None)
    monkeypatch.setitem(news_feed._state, "last_attempt", 0.0)
    monkeypatch.setitem(news_feed._state, "fetched_at", None)
    monkeypatch.setitem(news_feed._state, "error", None)
    monkeypatch.setitem(news_feed._state, "blocked_until", 0.0)
    calls = []

    def fake_urlopen(req, timeout):
        calls.append(req.full_url)
        return FakeResponse(json.dumps(FEED).encode())

    monkeypatch.setattr(news_feed.urllib.request, "urlopen", fake_urlopen)
    news.invalidate()
    yield calls
    news.invalidate()


def _wait_fetch():
    for _ in range(100):
        if not news_feed._state["running"]:
            return
        time.sleep(0.02)


def test_feed_is_converted_to_utc_and_normalised(feed):
    assert news_feed.refresh(force=True)
    _wait_fetch()
    df = news_feed.frame()
    nfp = df[df["event"] == "Non-Farm Employment Change"].iloc[0]
    assert nfp["time"] == pd.Timestamp("2024-01-05 13:30")
    assert nfp["actual"] == "" and nfp["forecast"] == "168K"
    hol = df[df["event"] == "Bank Holiday"].iloc[0]
    assert hol["impact"] == "Non-Economic" and bool(hol["all_day"])
    assert "ALL" in set(df["currency"])


def test_feed_is_rate_limited(feed):
    assert news_feed.refresh(force=True)
    _wait_fetch()
    assert news_feed.refresh() is False  # fresh data: no new request
    assert news_feed.refresh(force=True) is False  # even forced: not more than once a minute
    assert len(feed) == 1


def test_feed_merges_with_csv_and_csv_row_wins(feed, monkeypatch, tmp_path):
    csv = tmp_path / "ff.csv"
    csv.write_text(
        "Date,Time,Day,Currency,Impact,Event,Actual,Forecast,Previous,Time_Label,Event_ID\n"
        "2024-01-05,13:30,Friday,USD,High,Non-Farm Employment Change,216K,168K,173K,,1\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(news, "NEWS_FILE", csv)
    monkeypatch.setattr(news, "NEWS_TIMEZONE", "Europe/London")
    news_feed.refresh(force=True)
    _wait_fetch()
    news.invalidate()
    events = news.query(pd.Timestamp("2024-01-01"), pd.Timestamp("2024-01-10"), [], None, reveal_until=None)
    nfp = [e for e in events if e["event"] == "Non-Farm Employment Change"]
    assert len(nfp) == 1 and nfp[0]["actual"] == "216K"  # deduplicated, CSV (with actual) kept
    assert {e["event"] for e in events} >= {"German Factory Orders", "G20 Meetings"}  # feed-only events added


def test_429_retry_after_is_honoured(feed, monkeypatch):
    import urllib.error
    from email.message import Message

    hdrs = Message()
    hdrs["Retry-After"] = "288"

    def limited(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 429, "Too Many Requests", hdrs, None)

    monkeypatch.setattr(news_feed.urllib.request, "urlopen", limited)
    monkeypatch.setitem(news_feed._state, "blocked_until", 0.0)
    assert news_feed.refresh(force=True)
    _wait_fetch()
    assert "rate-limiting" in news_feed.status()["error"]
    assert news_feed._state["blocked_until"] > time.time() + 280
    monkeypatch.setitem(news_feed._state, "last_attempt", 0.0)
    assert news_feed.refresh(force=True) is False  # still blocked
    monkeypatch.setitem(news_feed._state, "blocked_until", 0.0)

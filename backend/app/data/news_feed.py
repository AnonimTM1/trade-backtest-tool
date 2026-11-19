"""This week's ForexFactory calendar from the public JSON feed.

ForexFactory's publisher (Fair Economy) serves the current week as
https://nfs.faireconomy.media/ff_calendar_thisweek.json - the same export the
site offers, so nothing is scraped. Each event carries a timezone-aware time
(e.g. "2026-11-16T08:30:00-05:00"), so conversion to UTC is exact.

The feed has no `actual` values (only forecast / previous). Every fetched week
is merged into an on-disk archive, so earlier weeks stay available after the
feed rolls over. The feed rate-limits clients that poll too often, so it is
fetched at most once every MIN_INTERVAL and always in a background thread.
"""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request

import pandas as pd

from app.config import DATA_DIR

FEED_URL = os.environ.get("NEWS_FEED_URL", "https://nfs.faireconomy.media/ff_calendar_thisweek.json")
ARCHIVE = DATA_DIR / "news" / "ff_feed_archive.json"
MIN_INTERVAL = float(os.environ.get("NEWS_FEED_MIN_INTERVAL_S", str(30 * 60)))
RETRY_AFTER_ERROR = 5 * 60
TIMEOUT = 20

_IMPACT = {"High": "High", "Medium": "Medium", "Low": "Low", "Holiday": "Non-Economic", "Non-Economic": "Non-Economic"}

_lock = threading.Lock()
_state = {"fetched_at": None, "error": None, "last_attempt": 0.0, "running": False, "version": 0, "week_count": 0, "blocked_until": 0.0}
_df_cache: tuple[int, pd.DataFrame] | None = None


def _key(e: dict) -> str:
    return f"{e['date']}|{e['country']}|{e['title']}"


def _read_archive() -> dict:
    try:
        return json.loads(ARCHIVE.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return {"fetched_at": None, "events": {}}


def _fetch() -> None:
    try:
        req = urllib.request.Request(FEED_URL, headers={"User-Agent": "trading-wiev/1.0 (economic calendar)"})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            body = r.read()
        events = json.loads(body)
        if not isinstance(events, list):
            raise ValueError("unexpected feed format")
        archive = _read_archive()
        for e in events:
            if all(k in e for k in ("title", "country", "date", "impact")):
                archive["events"][_key(e)] = {k: e.get(k, "") for k in ("title", "country", "date", "impact", "forecast", "previous")}
        archive["fetched_at"] = pd.Timestamp.utcnow().tz_localize(None).isoformat()
        ARCHIVE.parent.mkdir(parents=True, exist_ok=True)
        tmp = ARCHIVE.with_suffix(".tmp")
        tmp.write_text(json.dumps(archive), encoding="utf-8")
        tmp.replace(ARCHIVE)
        with _lock:
            _state.update(fetched_at=archive["fetched_at"], error=None, week_count=len(events))
            _state["version"] += 1
    except urllib.error.HTTPError as e:
        if e.code == 429:  # honour the server's Retry-After instead of guessing
            try:
                wait = float(e.headers.get("Retry-After") or RETRY_AFTER_ERROR)
            except ValueError:
                wait = RETRY_AFTER_ERROR
            with _lock:
                _state["blocked_until"] = time.time() + wait + 5
                _state["error"] = f"ForexFactory is rate-limiting requests; retrying in {int(wait / 60) + 1} min"
        else:
            with _lock:
                _state["error"] = f"HTTP {e.code} from the ForexFactory feed"
    except Exception as e:  # keep whatever we already have
        with _lock:
            _state["error"] = f"{type(e).__name__}: {e}"
    finally:
        with _lock:
            _state["running"] = False


def refresh(force: bool = False) -> bool:
    """Start a background fetch if the data is old enough. Returns True if started."""
    with _lock:
        if _state["running"] or time.time() < _state["blocked_until"]:
            return False
        if _state["fetched_at"] is None and _state["last_attempt"] == 0.0:
            _state["fetched_at"] = _read_archive().get("fetched_at")
        age = time.time() - _fetched_epoch()
        wait = RETRY_AFTER_ERROR if _state["error"] else MIN_INTERVAL
        since_attempt = time.time() - _state["last_attempt"]
        # even a forced refresh respects a short floor, so reloading the page can't hammer the feed
        if (not force and age < MIN_INTERVAL) or since_attempt < (60 if force else wait):
            return False
        _state["running"] = True
        _state["last_attempt"] = time.time()
    threading.Thread(target=_fetch, name="ff-feed", daemon=True).start()
    return True


def _fetched_epoch() -> float:
    f = _state["fetched_at"]
    return pd.Timestamp(f).timestamp() if f else 0.0


def version() -> int:
    """Changes whenever new feed data was stored (cache key for merging)."""
    try:
        st = ARCHIVE.stat()
        return hash((st.st_mtime_ns, st.st_size))
    except FileNotFoundError:
        return 0


def frame() -> pd.DataFrame | None:
    """Archived feed events in the same shape as the CSV calendar."""
    global _df_cache
    v = version()
    if v == 0:
        return None
    if _df_cache is not None and _df_cache[0] == v:
        return _df_cache[1]
    events = list(_read_archive()["events"].values())
    if not events:
        return None
    aware = pd.to_datetime([e["date"] for e in events], utc=True, errors="coerce")
    df = pd.DataFrame(
        {
            "time": aware.tz_convert("UTC").tz_localize(None),
            "currency": [("ALL" if e["country"].upper() == "ALL" else e["country"].upper()) for e in events],
            "impact": [_IMPACT.get(e["impact"], "Low") for e in events],
            "event": [e["title"].strip() for e in events],
            "actual": "",
            "forecast": [e.get("forecast") or "" for e in events],
            "previous": [e.get("previous") or "" for e in events],
            "label": ["All Day" if e["impact"] == "Holiday" else "" for e in events],
            "event_id": "",
            "all_day": [e["impact"] == "Holiday" for e in events],
        }
    )
    df = df[df["time"].notna()].sort_values("time", kind="stable").reset_index(drop=True)
    _df_cache = (v, df)
    return df


def status() -> dict:
    with _lock:
        st = dict(_state)
    if st["fetched_at"] is None:
        st["fetched_at"] = _read_archive().get("fetched_at")
    df = frame()
    return {
        "url": FEED_URL,
        "fetched_at": st["fetched_at"],
        "fetching": st["running"],
        "error": st["error"],
        "events": 0 if df is None else int(len(df)),
        "min_interval_s": MIN_INTERVAL,
    }

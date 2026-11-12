"""Economic calendar (ForexFactory CSV export) loading and querying.

CSV columns: Date,Time,Day,Currency,Impact,Event,Actual,Forecast,Previous,Time_Label,Event_ID

Timezone: ForexFactory exports are in the exporting account's timezone. The
bundled file is Europe/London (verified: US Non-Farm Payrolls, released at
08:30 New York time, is listed at 13:30 in both January and July, and the
XAUUSD M1 data shows the release spike at 12:30 UTC in summer). Times are
converted to naive UTC so they line up with the price data. Override with the
NEWS_TIMEZONE environment variable for exports made in another timezone.

Events without a clock time (All Day / Tentative / Day N) are placed at
00:00 of their date and flagged `all_day`.
"""
from __future__ import annotations

import os
import threading
from pathlib import Path

import numpy as np
import pandas as pd

from app.config import DATA_DIR

NEWS_DIR = DATA_DIR / "news"
NEWS_FILE = NEWS_DIR / "forexfactory_news.csv"
NEWS_TIMEZONE = os.environ.get("NEWS_TIMEZONE", "Europe/London")

IMPACTS = ["High", "Medium", "Low", "Non-Economic"]

# Instruments whose "currency" never appears in the calendar.
_NON_CALENDAR = {"XAU", "XAG", "XPT", "XPD", "BTC", "ETH", "LTC", "XRP", "OIL", "WTI", "BRN"}
_INDEX_CCY = {"US30": "USD", "US500": "USD", "SPX": "USD", "NAS": "USD", "NAS100": "USD", "USTEC": "USD",
              "GER": "EUR", "DE40": "EUR", "GER40": "EUR", "UK100": "GBP", "JP225": "JPY"}

_cache: tuple[tuple[int, int], pd.DataFrame] | None = None
_lock = threading.Lock()


def symbol_currencies(symbol: str) -> list[str]:
    """Calendar currencies relevant to a symbol: XAUUSD -> [USD], EURUSD -> [EUR, USD]."""
    s = symbol.upper()
    for prefix, ccy in _INDEX_CCY.items():
        if s.startswith(prefix):
            return [ccy]
    if len(s) >= 6 and s[:6].isalpha():
        parts = [s[:3], s[3:6]]
        out = [p for p in parts if p not in _NON_CALENDAR]
        return out or ["USD"]
    return ["USD"]


def _parse(path: Path) -> pd.DataFrame:
    raw = pd.read_csv(path, dtype=str, keep_default_na=False)
    required = {"Date", "Time", "Currency", "Impact", "Event"}
    missing = required - set(raw.columns)
    if missing:
        raise ValueError(f"News CSV is missing columns: {', '.join(sorted(missing))}")
    for col in ("Actual", "Forecast", "Previous", "Time_Label", "Event_ID"):
        if col not in raw.columns:
            raw[col] = ""

    has_time = raw["Time"].str.match(r"^\d{1,2}:\d{2}$")
    clock = raw["Time"].where(has_time, "00:00")
    local = pd.to_datetime(raw["Date"] + " " + clock, format="%Y-%m-%d %H:%M", errors="coerce")
    ok = local.notna()
    raw, local, has_time = raw[ok], local[ok], has_time[ok]

    if NEWS_TIMEZONE.upper() != "UTC":
        aware = local.dt.tz_localize(
            NEWS_TIMEZONE,
            ambiguous=np.zeros(len(local), dtype=bool),  # repeated autumn hour: take standard time
            nonexistent="shift_forward",
        )
        utc = aware.dt.tz_convert("UTC").dt.tz_localize(None)
    else:
        utc = local

    df = pd.DataFrame(
        {
            "time": utc.values,
            "currency": raw["Currency"].str.upper().str.strip().values,
            "impact": raw["Impact"].str.strip().values,
            "event": raw["Event"].str.strip().values,
            "actual": raw["Actual"].values,
            "forecast": raw["Forecast"].values,
            "previous": raw["Previous"].values,
            "label": raw["Time_Label"].values,
            "event_id": raw["Event_ID"].values,
            "all_day": (~has_time).values,
        }
    )
    df = df.sort_values("time", kind="stable").reset_index(drop=True)
    return df


def load() -> pd.DataFrame | None:
    global _cache
    try:
        st = NEWS_FILE.stat()
    except FileNotFoundError:
        return None
    key = (st.st_mtime_ns, st.st_size)
    with _lock:
        if _cache is not None and _cache[0] == key:
            return _cache[1]
    df = _parse(NEWS_FILE)
    with _lock:
        _cache = (key, df)
    return df


def save_upload(raw: bytes) -> int:
    """Validate and store an uploaded calendar CSV. Returns event count."""
    NEWS_DIR.mkdir(parents=True, exist_ok=True)
    tmp = NEWS_DIR / "upload.tmp"
    tmp.write_bytes(raw)
    try:
        df = _parse(tmp)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    tmp.replace(NEWS_FILE)
    invalidate()
    return len(df)


def invalidate() -> None:
    global _cache
    with _lock:
        _cache = None


def query(
    start: pd.Timestamp,
    end: pd.Timestamp,
    impacts: list[str],
    currencies: list[str] | None,
    reveal_until: pd.Timestamp | None,
    limit: int = 5000,
) -> list[dict]:
    """Events with start <= time <= end. `actual` is withheld for events
    after `reveal_until` (the replay cursor) so the calendar never leaks the
    outcome of a release the replay hasn't reached yet."""
    df = load()
    if df is None or df.empty:
        return []
    times = df["time"].values
    lo = np.searchsorted(times, np.datetime64(pd.Timestamp(start)), side="left")
    hi = np.searchsorted(times, np.datetime64(pd.Timestamp(end)), side="right")
    part = df.iloc[lo:hi]
    if impacts:
        part = part[part["impact"].isin(impacts)]
    if currencies:
        part = part[part["currency"].isin(currencies)]
    part = part.head(limit)

    cutoff = np.datetime64(pd.Timestamp(reveal_until)) if reveal_until is not None else None
    ms = ((pd.DatetimeIndex(part["time"]) - pd.Timestamp(0)) // pd.Timedelta(milliseconds=1)).astype("int64")
    out = []
    for t_ms, t, row in zip(ms, part["time"].values, part.itertuples(index=False)):
        released = cutoff is None or t <= cutoff
        out.append(
            {
                "timestamp": int(t_ms),
                "time": pd.Timestamp(t).isoformat(),
                "currency": row.currency,
                "impact": row.impact,
                "event": row.event,
                "actual": row.actual if released else None,
                "forecast": row.forecast,
                "previous": row.previous,
                "label": row.label,
                "all_day": bool(row.all_day),
                "released": bool(released),
            }
        )
    return out


def status() -> dict:
    df = load()
    if df is None or df.empty:
        return {"loaded": False, "count": 0, "first": None, "last": None, "source_timezone": NEWS_TIMEZONE}
    return {
        "loaded": True,
        "count": int(len(df)),
        "first": pd.Timestamp(df["time"].iloc[0]).isoformat(),
        "last": pd.Timestamp(df["time"].iloc[-1]).isoformat(),
        "source_timezone": NEWS_TIMEZONE,
        "currencies": sorted(df["currency"].unique().tolist()),
    }

"""Resampling of M1 bars to higher timeframes, with an in-memory cache and
support for building the TradingView-replay-style partial last candle.

Design notes (see README Decisions):
  - Imported timestamps are treated as naive "broker time".
  - For D1, day boundaries are aligned to local midnight in the symbol's
    configured timezone (naive timestamps are localized as UTC, converted to
    the target tz, floored/resampled, then converted back to naive UTC-like
    timestamps for storage/response consistency with M1 data).
  - M5/M15/M30/H1/H4 boundaries are fixed-length buckets aligned the same way
    regardless of timezone (this matches MT5/TradingView wall-clock bars).
  - The "no data after cursor" rule is enforced by construction: fully closed
    buckets come from a cache built off the *entire* M1 series (safe, because
    a closed bucket's contents never depend on data after its own end time,
    which is always <= cursor by definition), and the last, still-forming
    bucket is recomputed fresh from only the M1 rows at-or-before the cursor.
"""
from __future__ import annotations

import threading

import pandas as pd

from app.config import TIMEFRAME_MINUTES
from app.data import parquet_store

_RULE = {
    "M5": "5min",
    "M15": "15min",
    "M30": "30min",
    "H1": "1h",
    "H4": "4h",
    "D1": "1D",
}

_cache: dict[tuple[str, str, str], tuple[pd.DataFrame, pd.DataFrame]] = {}
_cache_lock = threading.Lock()


def _resample_ohlc(df_m1: pd.DataFrame, rule: str) -> pd.DataFrame:
    if df_m1.empty:
        return df_m1.copy()
    agg = {
        "open": "first",
        "high": "max",
        "low": "min",
        "close": "last",
        "volume": "sum",
        "spread": "last",
    }
    out = df_m1.resample(rule, label="left", closed="left").agg(agg)
    out = out.dropna(subset=["open", "high", "low", "close"])
    return out


def _localize_for_tz(df_m1: pd.DataFrame, tz: str) -> pd.DataFrame:
    if df_m1.empty or tz == "UTC":
        return df_m1
    localized = df_m1.copy()
    localized.index = localized.index.tz_localize("UTC").tz_convert(tz)
    return localized


def _delocalize(df: pd.DataFrame, tz: str) -> pd.DataFrame:
    if df.empty or tz == "UTC":
        return df
    out = df.copy()
    out.index = out.index.tz_convert("UTC").tz_localize(None)
    return out


def full_resample(symbol: str, tf: str, tz: str = "UTC") -> pd.DataFrame:
    """Fully-resampled series for the whole symbol, cached until the parquet
    file changes. Only safe to use for buckets that are entirely closed."""
    df_m1 = parquet_store.load_m1(symbol)
    # The M1 frame object is itself cached and replaced whenever the file
    # changes, so holding a reference to it and comparing identity is a cheap
    # and exact cache-validity check.
    token = df_m1
    key = (symbol.upper(), tf, tz)
    with _cache_lock:
        cached = _cache.get(key)
        if cached is not None and cached[0] is token:
            return cached[1]

    if tf == "M1":
        result = df_m1
    elif tf == "D1":
        localized = _localize_for_tz(df_m1, tz)
        resampled = _resample_ohlc(localized, _RULE["D1"])
        result = _delocalize(resampled, tz)
    else:
        result = _resample_ohlc(df_m1, _RULE[tf])

    with _cache_lock:
        _cache[key] = (token, result)
    return result


def floor_to_bucket(ts: pd.Timestamp, tf: str, tz: str = "UTC") -> pd.Timestamp:
    ts = pd.Timestamp(ts)
    if tf == "M1":
        return ts.floor("min")
    if tf == "D1":
        if tz == "UTC":
            return ts.floor("D")
        local = ts.tz_localize("UTC").tz_convert(tz)
        local_floor = local.floor("D")
        return local_floor.tz_convert("UTC").tz_localize(None)
    return ts.floor(_RULE[tf])


def advance_bucket(bucket_start: pd.Timestamp, tf: str, n: int, tz: str = "UTC") -> pd.Timestamp:
    """Return the bucket start that is `n` buckets after `bucket_start`
    (n may be negative to go backward). For D1, days are counted in the
    symbol's configured timezone so DST-shifted zones still advance by
    whole local days."""
    bucket_start = pd.Timestamp(bucket_start)
    if tf == "D1":
        if tz == "UTC":
            return bucket_start + pd.Timedelta(days=n)
        local = bucket_start.tz_localize("UTC").tz_convert(tz)
        local_advanced = local + pd.Timedelta(days=n)
        return local_advanced.tz_convert("UTC").tz_localize(None)
    minutes = TIMEFRAME_MINUTES[tf]
    return bucket_start + pd.Timedelta(minutes=minutes * n)


def build_partial_bar(df_m1_upto_cursor: pd.DataFrame, bucket_start: pd.Timestamp) -> dict | None:
    """Aggregate the M1 rows within [bucket_start, cursor] (df already
    truncated to cursor) into a single partial OHLC bar."""
    chunk = df_m1_upto_cursor[df_m1_upto_cursor.index >= bucket_start]
    if chunk.empty:
        return None
    return {
        "timestamp": bucket_start,
        "open": float(chunk["open"].iloc[0]),
        "high": float(chunk["high"].max()),
        "low": float(chunk["low"].min()),
        "close": float(chunk["close"].iloc[-1]),
        "volume": float(chunk["volume"].sum()),
        "spread": float(chunk["spread"].iloc[-1]) if "spread" in chunk else float("nan"),
    }


def get_bars_upto_cursor(
    symbol: str,
    tf: str,
    cursor: pd.Timestamp | None,
    tz: str = "UTC",
    before: pd.Timestamp | None = None,
    limit: int = 500,
) -> pd.DataFrame:
    """Return up to `limit` bars of timeframe `tf`, strictly at/before
    `cursor` (never after), optionally paginating backward via `before`.
    If `cursor` is None, the full available series is used (non-replay
    browsing mode)."""
    df_m1 = parquet_store.load_m1(symbol)
    if df_m1.empty:
        return df_m1

    if cursor is not None:
        df_m1_upto = parquet_store.upto(df_m1, pd.Timestamp(cursor))
    else:
        df_m1_upto = df_m1

    if df_m1_upto.empty:
        return df_m1_upto

    if tf == "M1":
        result = df_m1_upto
        if before is not None:
            result = result.iloc[: result.index.searchsorted(pd.Timestamp(before), side="left")]
        return result.tail(limit)

    closed = full_resample(symbol, tf, tz)
    last_m1_ts = df_m1_upto.index[-1]
    bucket_start = floor_to_bucket(last_m1_ts, tf, tz)

    closed_part = closed.iloc[: closed.index.searchsorted(bucket_start, side="left")]

    if before is not None:
        before_ts = pd.Timestamp(before)
        closed_part = closed_part.iloc[: closed_part.index.searchsorted(before_ts, side="left")]
        return closed_part.tail(limit)

    # Only the M1 rows of the still-forming bucket are needed for the partial bar.
    partial = build_partial_bar(
        df_m1_upto.iloc[df_m1_upto.index.searchsorted(bucket_start, side="left"):], bucket_start
    )

    rows = closed_part.tail(max(limit - 1, 0))
    if partial is not None:
        partial_df = pd.DataFrame([partial]).set_index("timestamp")
        rows = pd.concat([rows, partial_df])
    return rows.tail(limit)


def bars_since(
    symbol: str,
    tf: str,
    since: pd.Timestamp,
    cursor: pd.Timestamp,
    tz: str = "UTC",
    max_bars: int = 2000,
) -> pd.DataFrame:
    """All `tf` bars that changed between `since` (exclusive cursor of the
    previous step) and `cursor`: the bucket that contained `since` (it may
    have been completed) plus every bucket started afterwards, including the
    still-forming one. Used to push incremental updates to the chart after a
    replay step without reloading the whole visible series."""
    bars = get_bars_upto_cursor(symbol, tf, cursor=cursor, tz=tz, limit=max_bars)
    if bars.empty:
        return bars
    start_bucket = floor_to_bucket(pd.Timestamp(since), tf, tz)
    return bars.iloc[bars.index.searchsorted(start_bucket, side="left"):]


def invalidate_cache(symbol: str | None = None):
    parquet_store.invalidate(symbol)
    with _cache_lock:
        if symbol is None:
            _cache.clear()
        else:
            for key in list(_cache.keys()):
                if key[0] == symbol.upper():
                    del _cache[key]

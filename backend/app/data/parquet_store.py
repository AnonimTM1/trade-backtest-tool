"""Parquet-backed M1 storage with an in-memory, mtime-validated cache.

Every replay request (step, order, positions, bars...) needs the M1 series.
Re-reading a multi-year parquet file from disk on each call made replay
sluggish, so the parsed DataFrame is cached per symbol and reused until the
file on disk changes (mtime/size) or `invalidate()` is called.

Callers must treat the returned DataFrame as read-only.
"""
from __future__ import annotations

import threading
from pathlib import Path

import numpy as np
import pandas as pd

from app.config import PARQUET_DIR

COLUMNS = ["open", "high", "low", "close", "volume", "spread"]

_cache: dict[str, tuple[tuple[int, int], pd.DataFrame]] = {}
_lock = threading.Lock()


def symbol_dir(symbol: str) -> Path:
    return PARQUET_DIR / symbol.upper()


def m1_path(symbol: str) -> Path:
    return symbol_dir(symbol) / "M1.parquet"


def _empty() -> pd.DataFrame:
    return pd.DataFrame(
        {c: pd.Series(dtype="float64") for c in COLUMNS},
        index=pd.DatetimeIndex([], name="timestamp"),
    )


def _normalize(df: pd.DataFrame) -> pd.DataFrame:
    """Guarantee float columns (spread may be all-null/object in older files)
    and a sorted, unique DatetimeIndex."""
    if "volume" not in df.columns:
        df["volume"] = 0.0
    if "spread" not in df.columns:
        df["spread"] = np.nan
    df = df[COLUMNS].copy()
    for c in COLUMNS:
        df[c] = pd.to_numeric(df[c], errors="coerce").astype("float64")
    df["volume"] = df["volume"].fillna(0.0)
    if not df.index.is_monotonic_increasing:
        df = df.sort_index()
    if df.index.has_duplicates:
        df = df[~df.index.duplicated(keep="last")]
    df.index.name = "timestamp"
    return df


def rows_to_df(rows: list[dict]) -> pd.DataFrame:
    df = pd.DataFrame(rows)
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    df = df.set_index("timestamp")
    return _normalize(df)


def save_m1(symbol: str, rows: list[dict], merge: bool = True) -> int:
    """Write/merge M1 rows to the symbol's parquet file. Returns total row count after write."""
    new_df = rows_to_df(rows)
    path = m1_path(symbol)
    path.parent.mkdir(parents=True, exist_ok=True)
    if merge and path.exists():
        existing = pd.read_parquet(path)
        combined = pd.concat([existing, new_df])
        combined = combined[~combined.index.duplicated(keep="last")].sort_index()
    else:
        combined = new_df
    combined = _normalize(combined)
    combined.to_parquet(path, engine="pyarrow")
    invalidate(symbol)
    return len(combined)


def load_m1(symbol: str) -> pd.DataFrame:
    path = m1_path(symbol)
    try:
        st = path.stat()
    except FileNotFoundError:
        return _empty()
    key = (st.st_mtime_ns, st.st_size)
    name = symbol.upper()
    with _lock:
        cached = _cache.get(name)
        if cached is not None and cached[0] == key:
            return cached[1]
    df = _normalize(pd.read_parquet(path))
    with _lock:
        _cache[name] = (key, df)
    return df


def invalidate(symbol: str | None = None) -> None:
    with _lock:
        if symbol is None:
            _cache.clear()
        else:
            _cache.pop(symbol.upper(), None)


def upto(df: pd.DataFrame, ts: pd.Timestamp) -> pd.DataFrame:
    """Rows with index <= ts (binary search, O(log n))."""
    return df.iloc[: df.index.searchsorted(ts, side="right")]


def between(df: pd.DataFrame, after_ts: pd.Timestamp, before_ts: pd.Timestamp) -> pd.DataFrame:
    """Rows with after_ts < index < before_ts."""
    start = df.index.searchsorted(after_ts, side="right")
    end = df.index.searchsorted(before_ts, side="left")
    return df.iloc[start:max(start, end)]


def has_symbol(symbol: str) -> bool:
    return m1_path(symbol).exists()


def list_symbols() -> list[str]:
    if not PARQUET_DIR.exists():
        return []
    return sorted(p.name for p in PARQUET_DIR.iterdir() if p.is_dir() and (p / "M1.parquet").exists())

"""Import MT5 history into the local (offline) M1 store, and keep symbols updated.

Bars come from the MT5 bridge (`/rates_range`), already converted to UTC, with
MT5's own per-bar spread (in the broker's points). They are merged into the
same parquet store CSV imports and Dukascopy downloads use, so replay works
offline afterwards.

Auto-update: symbols registered in data/mt5_autosync.json are topped up in a
background thread every few minutes while MT5 is reachable (from the last
stored bar to now).
"""
from __future__ import annotations

import json
import re
import threading
import time
from datetime import datetime, timedelta
from typing import Callable, Optional

import pandas as pd

from app.config import DATA_DIR
from app.data import mt5_client, parquet_store, resample

CHUNK = timedelta(days=14)  # ~20k M1 bars per bridge call
AUTOSYNC_FILE = DATA_DIR / "mt5_autosync.json"
AUTOSYNC_INTERVAL_S = 300
AUTOSYNC_FIRST_DELAY_S = 15
NEW_SYMBOL_BACKFILL = timedelta(days=30)

_symbol_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock_for(symbol: str) -> threading.Lock:
    with _locks_guard:
        return _symbol_locks.setdefault(symbol, threading.Lock())


def local_name(broker_symbol: str) -> str:
    """'XAUUSD.r' -> 'XAUUSD.R': safe as a folder name, distinct from live 'MT5:' symbols."""
    return re.sub(r"[^A-Z0-9._-]", "_", broker_symbol.strip().upper()) or "MT5_SYMBOL"


def chunk_count(date_from: datetime, date_to: datetime) -> int:
    return max(1, -(-(date_to - date_from) // CHUNK))


def _to_rows(candles: list[dict]) -> list[dict]:
    return [
        {
            "timestamp": pd.Timestamp(int(c["timestamp"]), unit="ms").to_pydatetime(),
            "open": c["open"],
            "high": c["high"],
            "low": c["low"],
            "close": c["close"],
            "volume": c["volume"],
            "spread": c["spread"],
        }
        for c in candles
    ]


def import_range(
    broker_symbol: str,
    symbol: str,
    date_from: datetime,
    date_to: datetime,
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> dict:
    """Fetch [date_from, date_to) M1 bars from MT5 and merge them into `symbol`.
    Returns {"rows", "first", "last"}. Raises mt5_client errors."""
    total = chunk_count(date_from, date_to)
    rows: list[dict] = []
    start = date_from
    done = 0
    while start < date_to:
        end = min(start + CHUNK, date_to)
        candles = mt5_client.rates_range(
            broker_symbol, "M1", int(pd.Timestamp(start).value // 1_000_000), int(pd.Timestamp(end).value // 1_000_000)
        )
        rows.extend(_to_rows(candles))
        done += 1
        if on_progress:
            on_progress(done, total)
        start = end
    if rows:
        with _lock_for(symbol):
            parquet_store.save_m1(symbol, rows, merge=True)
            resample.invalidate_cache(symbol)
    return {
        "rows": len(rows),
        "first": rows[0]["timestamp"] if rows else None,
        "last": rows[-1]["timestamp"] if rows else None,
    }


def history_warning(date_from: datetime, first: Optional[datetime]) -> Optional[str]:
    """MT5 only serves as much M1 history as its 'Max bars in chart' setting allows."""
    if first is None:
        return (
            "MetaTrader 5 returned no bars for this range. Check the dates, or open the symbol's M1 chart in MT5 "
            "once so it downloads its history, then import again."
        )
    if first - date_from > timedelta(days=4):  # more than a weekend/holiday short
        return (
            f"MetaTrader 5 only had M1 data from {first:%Y-%m-%d %H:%M} UTC. To import older data, raise "
            "Tools > Options > Charts > 'Max bars in chart' in MT5 (e.g. to Unlimited), restart MT5, "
            "scroll the M1 chart back, and import again."
        )
    return None


# ---------------------------------------------------------------------------
# Auto-update
# ---------------------------------------------------------------------------

_auto_lock = threading.Lock()
_thread_started = False


def autosync_list() -> list[dict]:
    try:
        return json.loads(AUTOSYNC_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return []


def _save_list(items: list[dict]) -> None:
    AUTOSYNC_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = AUTOSYNC_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(items, indent=2, default=str), encoding="utf-8")
    tmp.replace(AUTOSYNC_FILE)


def set_autosync(symbol: str, broker_symbol: str, enabled: bool) -> list[dict]:
    with _auto_lock:
        items = [i for i in autosync_list() if i["symbol"] != symbol]
        if enabled:
            items.append({"symbol": symbol, "broker": broker_symbol, "last_sync": None, "last_error": None})
        _save_list(items)
        return items


def _update(symbol: str, **fields) -> None:
    with _auto_lock:
        items = autosync_list()
        for i in items:
            if i["symbol"] == symbol:
                i.update(fields)
        _save_list(items)


def sync_symbol(entry: dict) -> int:
    """Append bars from the last stored one up to now. Returns rows fetched."""
    symbol, broker = entry["symbol"], entry["broker"]
    m1 = parquet_store.load_m1(symbol)
    now = pd.Timestamp.utcnow().tz_localize(None).to_pydatetime()
    start = (m1.index[-1].to_pydatetime() + timedelta(minutes=1)) if not m1.empty else now - NEW_SYMBOL_BACKFILL
    if start >= now:
        return 0
    res = import_range(broker, symbol, start, now)
    return res["rows"]


def sync_all() -> dict:
    """One auto-update pass over every registered symbol (skipped if MT5 is unreachable)."""
    items = autosync_list()
    if not items:
        return {"ran": False, "reason": "nothing registered"}
    st = mt5_client.status()
    if not st.get("connected"):
        return {"ran": False, "reason": st.get("error") or "MetaTrader 5 not connected"}
    results = {}
    for entry in items:
        try:
            n = sync_symbol(entry)
            _update(entry["symbol"], last_sync=datetime.utcnow().isoformat(timespec="seconds"), last_error=None)
            results[entry["symbol"]] = n
        except (mt5_client.BridgeUnavailable, mt5_client.BridgeRequestError) as e:
            _update(entry["symbol"], last_error=str(e))
            results[entry["symbol"]] = f"error: {e}"
    return {"ran": True, "results": results}


def _loop() -> None:
    time.sleep(AUTOSYNC_FIRST_DELAY_S)
    while True:
        try:
            sync_all()
        except Exception:
            pass  # never let the background thread die
        time.sleep(AUTOSYNC_INTERVAL_S)


def start_autosync_thread() -> None:
    global _thread_started
    if _thread_started:
        return
    _thread_started = True
    threading.Thread(target=_loop, name="mt5-autosync", daemon=True).start()

"""Client for the read-only MT5 bridge (mt5bridge/bridge.py on the Windows host).

Live sessions store their symbol as ``MT5:<broker symbol>`` so the rest of the
app (sessions, orders, drawings, stats) keeps working unchanged; only the
price source differs.
"""
from __future__ import annotations

import json
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request

PREFIX = "MT5:"
BRIDGE_URL = os.environ.get("MT5_BRIDGE_URL", "http://host.docker.internal:8765").rstrip("/")
TIMEOUT = float(os.environ.get("MT5_BRIDGE_TIMEOUT", "5"))
# MT5 may have to download history from the broker first (seconds to a minute)
HISTORY_TIMEOUT = float(os.environ.get("MT5_BRIDGE_HISTORY_TIMEOUT", "90"))


class BridgeUnavailable(Exception):
    """The bridge isn't running / MT5 isn't connected."""


class BridgeRequestError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def is_live(symbol: str | None) -> bool:
    return bool(symbol) and symbol.upper().startswith(PREFIX)


def broker_symbol(symbol: str) -> str:
    """'MT5:XAUUSD' -> 'XAUUSD' (broker symbols are case sensitive: keep it)."""
    return symbol[len(PREFIX):] if is_live(symbol) else symbol


_down_until = 0.0
_down_reason = ""


def _get(path: str, timeout: float = TIMEOUT, **params) -> dict:
    global _down_until, _down_reason
    # After a connection failure, fail fast for a few seconds instead of letting
    # every request (e.g. listing several live sessions) wait for the timeout.
    if time.time() < _down_until:
        raise BridgeUnavailable(_down_reason)
    q = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    url = f"{BRIDGE_URL}{path}" + (f"?{q}" if q else "")
    try:
        return _fetch(url, timeout)
    except BridgeUnavailable as e:
        _down_until, _down_reason = time.time() + 3, str(e)
        raise


def _is_timeout(e: BaseException) -> bool:
    reason = getattr(e, "reason", e)
    return isinstance(reason, (TimeoutError, socket.timeout)) or "timed out" in str(reason)


def _fetch(url: str, timeout: float) -> dict:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read()).get("detail", str(e))
        except Exception:
            detail = str(e)
        if e.code == 503:
            raise BridgeUnavailable(detail) from e
        raise BridgeRequestError(e.code, detail) from e
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
        # A slow answer means MT5 is busy (typically downloading history), not
        # that the bridge is gone: report it without marking the bridge down.
        if _is_timeout(e):
            raise BridgeRequestError(504, "MetaTrader 5 is busy (downloading history?) - try again in a moment") from e
        raise BridgeUnavailable(
            f"MT5 bridge not reachable at {BRIDGE_URL} ({getattr(e, 'reason', e)}). "
            "Start it with start-mt5-bridge.bat on the Windows machine running MetaTrader 5."
        ) from e


def status() -> dict:
    try:
        st = _get("/status")
    except BridgeUnavailable as e:
        return {"connected": False, "bridge": False, "error": str(e), "url": BRIDGE_URL}
    return {**st, "bridge": True, "url": BRIDGE_URL}


def symbols() -> list[dict]:
    return _get("/symbols", timeout=30)["symbols"]


_info_cache: dict[str, tuple[float, dict]] = {}


def symbol_info(name: str) -> dict:
    hit = _info_cache.get(name)
    if hit and time.time() - hit[0] < 300:
        return hit[1]
    info = _get("/symbol", symbol=name)
    _info_cache[name] = (time.time(), info)
    return info


def tick(name: str) -> dict:
    return _get("/tick", symbol=name)


def is_busy(e: BaseException) -> bool:
    """MT5 is temporarily busy (e.g. downloading history), not disconnected."""
    return isinstance(e, BridgeRequestError) and e.status in (429, 504)


def rates(name: str, tf: str, count: int, before_ms: int | None = None, timeout: float = HISTORY_TIMEOUT) -> list[dict]:
    return _get("/rates", timeout=timeout, symbol=name, tf=tf, count=count, before_ms=before_ms)["candles"]


def ticks(name: str, from_ms: int, to_ms: int) -> list[list[float]]:
    """[[utc_ms, bid, ask], ...] oldest first."""
    long_range = to_ms - from_ms > 3_600_000
    return _get("/ticks", timeout=HISTORY_TIMEOUT if long_range else TIMEOUT, symbol=name, from_ms=from_ms, to_ms=to_ms)["ticks"]

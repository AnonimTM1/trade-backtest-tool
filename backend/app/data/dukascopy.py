"""Downloads historical tick data from Dukascopy's public datafeed (no API
key required) and aggregates it into M1 OHLC rows in the same shape produced
by csv_import, so it can be merged straight into a symbol's parquet store.

URL scheme, binary tick record layout and per-instrument price scaling were
verified against Dukascopy-datafeed reference implementations (the record
format is undocumented by Dukascopy itself but is a well-established, widely
replicated reverse-engineering: 20-byte big-endian records of
(time_offset_ms: u32, ask: u32, bid: u32, ask_volume: f32, bid_volume: f32)
per hourly .bi5 file, LZMA-compressed, with a fixed price divisor per
instrument — see PIPET_SCALE_REGISTRY below).
"""
from __future__ import annotations

import asyncio
import lzma
import struct
from datetime import datetime, timedelta
from typing import Callable, Optional

import httpx

DATAFEED_BASE = "https://datafeed.dukascopy.com/datafeed/"

# Price divisor per instrument: real_price = raw_integer * scale.
PIPET_SCALE_REGISTRY: dict[str, float] = {
    "EURUSD": 1e-5,
    "GBPUSD": 1e-5,
    "AUDUSD": 1e-5,
    "NZDUSD": 1e-5,
    "USDCAD": 1e-5,
    "USDCHF": 1e-5,
    "USDJPY": 1e-3,
    "XAUUSD": 1e-3,
    "XAGUSD": 1e-3,
    "BTCUSD": 0.1,
    "ETHUSD": 0.1,
}

_TICK_STRUCT = struct.Struct(">IIIff")  # u32 time, u32 ask, u32 bid, f32 ask_vol, f32 bid_vol


class DukascopyError(Exception):
    pass


def supported_symbols() -> list[str]:
    return sorted(PIPET_SCALE_REGISTRY)


def _hour_url(symbol: str, hour_start: datetime) -> str:
    month0 = hour_start.month - 1  # Dukascopy months are 0-indexed (00-11) in URLs
    return (
        f"{DATAFEED_BASE}{symbol}/{hour_start.year}/{month0:02d}/"
        f"{hour_start.day:02d}/{hour_start.hour:02d}h_ticks.bi5"
    )


def count_hours(date_from: datetime, date_to: datetime) -> int:
    return len(_hourly_range(date_from, date_to))


def _hourly_range(date_from: datetime, date_to: datetime) -> list[datetime]:
    if date_to <= date_from:
        return []
    start = date_from.replace(minute=0, second=0, microsecond=0)
    end = date_to.replace(minute=0, second=0, microsecond=0)
    hours = []
    current = start
    while current < end:
        hours.append(current)
        current += timedelta(hours=1)
    return hours


def _decode_hour_ticks(raw: bytes, hour_start: datetime, scale: float) -> list[dict]:
    if not raw:
        return []
    try:
        data = lzma.decompress(raw)
    except lzma.LZMAError as e:
        raise DukascopyError(f"Failed to decompress tick data: {e}") from e

    size = _TICK_STRUCT.size
    ticks = []
    for offset in range(0, len(data) - size + 1, size):
        time_ms, ask_raw, bid_raw, ask_vol, bid_vol = _TICK_STRUCT.unpack_from(data, offset)
        ticks.append(
            {
                "timestamp": hour_start + timedelta(milliseconds=time_ms),
                "ask": ask_raw * scale,
                "bid": bid_raw * scale,
                "bid_volume": bid_vol,
            }
        )
    return ticks


def _ticks_to_m1_rows(ticks: list[dict]) -> list[dict]:
    """Aggregate ticks (any order) into M1 OHLC rows using the BID price
    (matching this app's MT5-style bar convention). Each row also carries
    `avg_spread_price` (ask-bid, in real price units) for the caller to
    convert into "points" using the symbol's configured point size."""
    if not ticks:
        return []
    buckets: dict[datetime, list[dict]] = {}
    for t in ticks:
        bucket = t["timestamp"].replace(second=0, microsecond=0)
        buckets.setdefault(bucket, []).append(t)

    rows = []
    for bucket_ts in sorted(buckets):
        bucket_ticks = sorted(buckets[bucket_ts], key=lambda t: t["timestamp"])
        bids = [t["bid"] for t in bucket_ticks]
        spreads = [t["ask"] - t["bid"] for t in bucket_ticks]
        rows.append(
            {
                "timestamp": bucket_ts,
                "open": bids[0],
                "high": max(bids),
                "low": min(bids),
                "close": bids[-1],
                "volume": sum(t["bid_volume"] for t in bucket_ticks) * 1_000_000,
                "avg_spread_price": sum(spreads) / len(spreads),
            }
        )
    return rows


MAX_ATTEMPTS = 8
MAX_BACKOFF_S = 30.0
GIVE_UP_AFTER = 12  # consecutive failed hours (nothing getting through): stop instead of grinding on


class _HourFailed(Exception):
    """An hour that could not be fetched (rate limited / network), as opposed to
    an hour that has no data (404/403, weekends and holidays)."""


class _Throttle:
    """Shared pause for all workers: when Dukascopy answers 429/503, everyone
    backs off together instead of each worker hammering it again."""

    def __init__(self):
        self.until = 0.0

    async def wait(self):
        delay = self.until - asyncio.get_running_loop().time()
        if delay > 0:
            await asyncio.sleep(delay)

    def pause(self, seconds: float):
        self.until = max(self.until, asyncio.get_running_loop().time() + seconds)


def _retry_after(resp: httpx.Response, attempt: int) -> float:
    try:
        value = float(resp.headers.get("Retry-After", ""))
        if value > 0:
            return min(value, 120.0)
    except ValueError:
        pass
    return min(MAX_BACKOFF_S, 1.5 * 2 ** attempt)


async def _fetch_hour(client: httpx.AsyncClient, symbol: str, hour_start: datetime,
                      throttle: Optional[_Throttle] = None) -> bytes:
    """Bytes of one hour's .bi5 file, b"" when the hour has no data, raises
    _HourFailed when it couldn't be fetched after all retries."""
    throttle = throttle or _Throttle()
    url = _hour_url(symbol, hour_start)
    last = "no response"
    for attempt in range(MAX_ATTEMPTS):
        await throttle.wait()
        try:
            resp = await client.get(url)
        except httpx.HTTPError as e:
            last = f"{type(e).__name__}"
            await asyncio.sleep(min(MAX_BACKOFF_S, 1.0 * 2 ** attempt))
            continue
        if resp.status_code == 200:
            return resp.content
        if resp.status_code in (404, 403):
            return b""  # no data published for this hour (e.g. weekend/holiday)
        last = f"HTTP {resp.status_code}"
        if resp.status_code in (429, 503):  # rate limited: pause every worker
            throttle.pause(_retry_after(resp, attempt))
        else:
            await asyncio.sleep(min(MAX_BACKOFF_S, 1.0 * 2 ** attempt))
    raise _HourFailed(last)


async def download_m1_range(
    symbol: str,
    date_from: datetime,
    date_to: datetime,
    point_size: float,
    pipet_scale: Optional[float] = None,
    concurrency: int = 4,
    on_progress: Optional[Callable[[int, int], None]] = None,
    failed: Optional[list] = None,
) -> list[dict]:
    """Download + decode Dukascopy ticks for `symbol` in [date_from, date_to)
    (naive UTC) and return M1 rows shaped like csv_import's:
    timestamp/open/high/low/close/volume/spread (spread in points).

    Hours that could not be fetched (rate limit / network, after retries) are
    appended to `failed` instead of silently counting as "no data"; running
    the same download again fills them in (imports merge)."""
    symbol = symbol.upper()
    scale = pipet_scale if pipet_scale is not None else PIPET_SCALE_REGISTRY.get(symbol)
    if scale is None:
        raise DukascopyError(
            f"No known price scale for symbol {symbol!r}. Supported without manual "
            f"scale: {', '.join(supported_symbols())}."
        )

    hours = _hourly_range(date_from, date_to)
    if not hours:
        raise DukascopyError("date_to must be after date_from")

    sem = asyncio.Semaphore(concurrency)
    throttle = _Throttle()
    streak = {"fails": 0, "ok": 0}
    gave_up = False
    m1_rows: list[dict] = []
    rows_lock = asyncio.Lock()
    done_count = 0
    progress_lock = asyncio.Lock()

    async with httpx.AsyncClient(timeout=30.0, headers={"User-Agent": "trading-wiev/1.0"}) as client:

        async def worker(hour_start: datetime):
            nonlocal done_count, gave_up
            async with sem:
                if gave_up:
                    raw = b""
                    if failed is not None:
                        failed.append(hour_start)
                else:
                    try:
                        raw = await _fetch_hour(client, symbol, hour_start, throttle)
                        streak["fails"] = 0
                        streak["ok"] += 1
                    except _HourFailed:
                        raw = b""
                        streak["fails"] += 1
                        if failed is not None:
                            failed.append(hour_start)
                        if streak["fails"] >= GIVE_UP_AFTER:
                            gave_up = True
            if raw:
                ticks = _decode_hour_ticks(raw, hour_start, scale)
                hour_rows = _ticks_to_m1_rows(ticks)
                if hour_rows:
                    async with rows_lock:
                        m1_rows.extend(hour_rows)
            async with progress_lock:
                done_count += 1
                if on_progress:
                    on_progress(done_count, len(hours))

        await asyncio.gather(*(worker(h) for h in hours))

    if gave_up and not streak["ok"]:
        raise DukascopyError(
            "Could not reach Dukascopy (every request failed: no internet connection, or the server is "
            "rate-limiting this IP). Try again in a few minutes."
        )

    m1_rows.sort(key=lambda r: r["timestamp"])
    for row in m1_rows:
        spread_price = row.pop("avg_spread_price")
        row["spread"] = round(spread_price / point_size, 1) if point_size else None
    return m1_rows

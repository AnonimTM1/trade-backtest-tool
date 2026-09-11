import lzma
import struct
from datetime import datetime

import pytest

from app.data import dukascopy


def _make_bi5(ticks: list[tuple[int, int, int, float, float]]) -> bytes:
    """ticks: list of (time_ms_offset, ask_raw, bid_raw, ask_vol, bid_vol)"""
    packer = struct.Struct(">IIIff")
    raw = b"".join(packer.pack(*t) for t in ticks)
    return lzma.compress(raw, format=lzma.FORMAT_ALONE)


def test_decode_hour_ticks_roundtrip():
    hour_start = datetime(2024, 1, 2, 10, 0, 0)
    scale = 1e-3
    # two ticks: at +0ms and +90000ms (90s -> minute 1), prices as raw ints
    blob = _make_bi5(
        [
            (0, 2050900, 2050700, 1.0, 2.0),
            (90_000, 2051100, 2050800, 1.5, 1.0),
        ]
    )
    ticks = dukascopy._decode_hour_ticks(blob, hour_start, scale)
    assert len(ticks) == 2
    assert ticks[0]["timestamp"] == hour_start
    assert ticks[0]["bid"] == 2050.7
    assert ticks[0]["ask"] == 2050.9
    assert ticks[1]["timestamp"] == datetime(2024, 1, 2, 10, 1, 30)
    assert ticks[1]["bid"] == 2050.8


def test_decode_empty_blob_returns_no_ticks():
    assert dukascopy._decode_hour_ticks(b"", datetime(2024, 1, 1), 1e-3) == []


def test_ticks_to_m1_rows_aggregates_ohlc_and_spread():
    hour_start = datetime(2024, 1, 2, 10, 0, 0)
    ticks = [
        {"timestamp": hour_start, "ask": 2050.9, "bid": 2050.7, "bid_volume": 1.0},
        {"timestamp": hour_start.replace(second=30), "ask": 2051.3, "bid": 2051.0, "bid_volume": 2.0},
        {"timestamp": hour_start.replace(second=45), "ask": 2050.5, "bid": 2050.2, "bid_volume": 1.0},
        # next minute
        {"timestamp": hour_start.replace(minute=1, second=5), "ask": 2052.0, "bid": 2051.8, "bid_volume": 3.0},
    ]
    rows = dukascopy._ticks_to_m1_rows(ticks)
    assert len(rows) == 2
    first = rows[0]
    assert first["timestamp"] == hour_start
    assert first["open"] == 2050.7  # first bid
    assert first["close"] == 2050.2  # last bid
    assert first["high"] == 2051.0
    assert first["low"] == 2050.2
    assert first["avg_spread_price"] == pytest.approx((0.2 + 0.3 + 0.3) / 3)

    second = rows[1]
    assert second["timestamp"] == hour_start.replace(minute=1, second=0)
    assert second["open"] == 2051.8


def test_hourly_range_generates_expected_hours():
    hours = dukascopy._hourly_range(datetime(2024, 1, 1, 10, 30), datetime(2024, 1, 1, 13, 0))
    assert hours == [
        datetime(2024, 1, 1, 10),
        datetime(2024, 1, 1, 11),
        datetime(2024, 1, 1, 12),
    ]


def test_hour_url_uses_zero_indexed_month():
    url = dukascopy._hour_url("XAUUSD", datetime(2024, 3, 2, 12))
    assert url == "https://datafeed.dukascopy.com/datafeed/XAUUSD/2024/02/02/12h_ticks.bi5"


def test_january_is_month_00():
    url = dukascopy._hour_url("EURUSD", datetime(2024, 1, 15, 9))
    assert url == "https://datafeed.dukascopy.com/datafeed/EURUSD/2024/00/15/09h_ticks.bi5"


def test_unsupported_symbol_requires_manual_scale():
    import asyncio

    async def run():
        try:
            await dukascopy.download_m1_range("UNKNOWNPAIR", datetime(2024, 1, 1), datetime(2024, 1, 2), 0.01)
            assert False, "expected DukascopyError"
        except dukascopy.DukascopyError as e:
            assert "UNKNOWNPAIR" in str(e)

    asyncio.run(run())

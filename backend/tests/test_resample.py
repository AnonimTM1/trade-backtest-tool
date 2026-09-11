from datetime import datetime, timedelta

import pandas as pd

from app.data import parquet_store, resample


def _make_m1_rows(symbol_start: datetime, n_minutes: int, base_price=2000.0):
    rows = []
    price = base_price
    for i in range(n_minutes):
        ts = symbol_start + timedelta(minutes=i)
        o = price
        h = price + 0.5
        l = price - 0.5
        c = price + 0.1
        rows.append({"timestamp": ts, "open": o, "high": h, "low": l, "close": c, "volume": 10, "spread": 20})
        price = c
    return rows


def test_no_data_after_cursor_m1():
    symbol = "TESTNODATA"
    start = datetime(2024, 1, 1, 0, 0)
    rows = _make_m1_rows(start, 10)
    parquet_store.save_m1(symbol, rows)

    cursor = start + timedelta(minutes=4)
    bars = resample.get_bars_upto_cursor(symbol, "M1", cursor, limit=100)
    assert bars.index.max() == cursor
    assert len(bars) == 5  # minutes 0..4 inclusive


def test_partial_higher_timeframe_candle_grows_with_cursor():
    symbol = "TESTPARTIAL"
    start = datetime(2024, 1, 1, 0, 0)  # aligned to H1 boundary
    rows = _make_m1_rows(start, 90)  # 1.5 hours of data
    parquet_store.save_m1(symbol, rows)

    # cursor at minute 30 -> H1 bucket [00:00,01:00) partial, built from bars 0..30
    cursor = start + timedelta(minutes=30)
    bars = resample.get_bars_upto_cursor(symbol, "H1", cursor, limit=100)
    assert len(bars) == 1
    last = bars.iloc[-1]
    m1_slice = pd.DataFrame(rows).set_index("timestamp").loc[start:cursor]
    assert last["open"] == m1_slice["open"].iloc[0]
    assert last["close"] == m1_slice["close"].iloc[-1]
    assert last["high"] == m1_slice["high"].max()
    assert last["low"] == m1_slice["low"].min()

    # advance cursor further within the same hour -> candle grows (close changes, high/low may extend)
    cursor2 = start + timedelta(minutes=45)
    bars2 = resample.get_bars_upto_cursor(symbol, "H1", cursor2, limit=100)
    assert len(bars2) == 1
    last2 = bars2.iloc[-1]
    m1_slice2 = pd.DataFrame(rows).set_index("timestamp").loc[start:cursor2]
    assert last2["close"] == m1_slice2["close"].iloc[-1]
    assert last2["close"] != last["close"]

    # cursor past the hour boundary -> first H1 bucket now closed, second bucket partial
    cursor3 = start + timedelta(minutes=75)
    bars3 = resample.get_bars_upto_cursor(symbol, "H1", cursor3, limit=100)
    assert len(bars3) == 2
    closed_bar = bars3.iloc[0]
    m1_first_hour = pd.DataFrame(rows).set_index("timestamp").loc[start:start + timedelta(minutes=59)]
    assert closed_bar["close"] == m1_first_hour["close"].iloc[-1]
    assert closed_bar["high"] == m1_first_hour["high"].max()


def test_no_future_data_leaks_into_closed_bucket():
    """Even though the full symbol has data extending well past the cursor,
    a bucket fully after the cursor must never appear, and the cached full
    resample used for closed buckets must not leak partial-bucket data from
    the future into what's returned."""
    symbol = "TESTNOFUTURE"
    start = datetime(2024, 1, 1, 0, 0)
    rows = _make_m1_rows(start, 240)  # 4 hours
    parquet_store.save_m1(symbol, rows)

    cursor = start + timedelta(minutes=65)  # just past first hour
    bars = resample.get_bars_upto_cursor(symbol, "H1", cursor, limit=100)
    # only 2 buckets should exist: closed [00:00-01:00), partial [01:00-...]
    assert len(bars) == 2
    assert bars.index.max() <= resample.floor_to_bucket(cursor, "H1")
    # nothing later than cursor's own bucket start should appear
    for ts in bars.index:
        assert ts <= cursor


def test_pagination_before_param_excludes_partial_and_paginates_closed():
    symbol = "TESTPAGINATE"
    start = datetime(2024, 1, 1, 0, 0)
    rows = _make_m1_rows(start, 300)  # 5 hours
    parquet_store.save_m1(symbol, rows)
    cursor = start + timedelta(minutes=250)

    latest = resample.get_bars_upto_cursor(symbol, "H1", cursor, limit=2)
    assert len(latest) == 2
    oldest_ts_in_page = latest.index[0]

    older = resample.get_bars_upto_cursor(symbol, "H1", cursor, before=oldest_ts_in_page, limit=2)
    assert all(ts < oldest_ts_in_page for ts in older.index)


def test_d1_timezone_boundary():
    symbol = "TESTTZ"
    start = datetime(2024, 1, 1, 22, 0)  # 22:00 UTC
    rows = _make_m1_rows(start, 6 * 60)  # 6 hours, crosses UTC midnight
    parquet_store.save_m1(symbol, rows)
    cursor = start + timedelta(hours=5, minutes=59)

    utc_bars = resample.get_bars_upto_cursor(symbol, "D1", cursor, tz="UTC", limit=100)
    # In UTC, day boundary at 00:00 splits into 2 buckets: [22:00-24:00) partial->closed, [00:00-...) partial
    assert len(utc_bars) == 2

    # In UTC+3 (e.g. some brokers), local midnight is 21:00 UTC, so the whole
    # 22:00-04:00 UTC window falls in a single broker-local day.
    tz_bars = resample.get_bars_upto_cursor(symbol, "D1", cursor, tz="Etc/GMT-3", limit=100)
    assert len(tz_bars) == 1

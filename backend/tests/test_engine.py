from datetime import datetime, timedelta

import pytest

from app.engine import engine
from app.engine.models import Bar

XAUUSD_POINT = 0.01
XAUUSD_CONTRACT = 100.0


def bar(ts, o, h, l, c, spread=None):
    return Bar(timestamp=ts, open=o, high=h, low=l, close=c, spread=spread)


def test_market_buy_fills_at_ask_close_plus_spread():
    b = bar(datetime(2024, 1, 1), 2000, 2000.5, 1999.5, 2000.2, spread=20)
    pos = engine.open_market_position(
        b, "buy", lots=1, contract_size=XAUUSD_CONTRACT, point_size=XAUUSD_POINT,
        default_spread_points=20,
    )
    # ask = bid_close + spread_points*point_size = 2000.2 + 20*0.01 = 2000.4
    assert pos.open_price == pytest.approx(2000.4)


def test_market_sell_fills_at_bid_close_no_spread_added():
    b = bar(datetime(2024, 1, 1), 2000, 2000.5, 1999.5, 2000.2, spread=20)
    pos = engine.open_market_position(
        b, "sell", lots=1, contract_size=XAUUSD_CONTRACT, point_size=XAUUSD_POINT,
        default_spread_points=20,
    )
    assert pos.open_price == pytest.approx(2000.2)


def test_default_spread_used_when_bar_has_none():
    b = bar(datetime(2024, 1, 1), 2000, 2000.5, 1999.5, 2000.0, spread=None)
    pos = engine.open_market_position(
        b, "buy", lots=1, contract_size=XAUUSD_CONTRACT, point_size=XAUUSD_POINT,
        default_spread_points=30,
    )
    assert pos.open_price == pytest.approx(2000.0 + 30 * 0.01)


def test_pnl_buy_with_contract_size():
    pnl = engine.pricing.pnl("buy", open_price=2000.0, close_price=2005.0, lots=0.5, contract_size=100.0)
    assert pnl == pytest.approx((2005.0 - 2000.0) * 0.5 * 100.0)  # 250.0


def test_pnl_sell_with_contract_size():
    pnl = engine.pricing.pnl("sell", open_price=2005.0, close_price=2000.0, lots=2, contract_size=100.0)
    assert pnl == pytest.approx((2005.0 - 2000.0) * 2 * 100.0)  # 1000.0


def test_long_sl_hit_within_bar_fills_at_sl_price_not_low():
    pos = engine.EnginePosition(
        id="p1", side="buy", lots=1, open_price=2000, open_time=datetime(2024, 1, 1),
        contract_size=100, point_size=0.01, sl=1995.0, tp=2010.0,
    )
    positions = {"p1": pos}
    b = bar(datetime(2024, 1, 1, 0, 1), 2000, 2001, 1990, 1996, spread=0)  # low breaches SL hard
    closed = engine.process_m1_bar(positions, b, default_spread_points=0)
    assert len(closed) == 1
    assert closed[0].close_reason == "sl"
    assert closed[0].close_price == pytest.approx(1995.0)
    assert "p1" not in positions


def test_long_tp_hit_within_bar():
    pos = engine.EnginePosition(
        id="p1", side="buy", lots=1, open_price=2000, open_time=datetime(2024, 1, 1),
        contract_size=100, point_size=0.01, sl=1995.0, tp=2010.0,
    )
    positions = {"p1": pos}
    b = bar(datetime(2024, 1, 1, 0, 1), 2000, 2012, 1999, 2005, spread=0)
    closed = engine.process_m1_bar(positions, b, default_spread_points=0)
    assert closed[0].close_reason == "tp"
    assert closed[0].close_price == pytest.approx(2010.0)


def test_sl_before_tp_when_both_touched_same_bar():
    pos = engine.EnginePosition(
        id="p1", side="buy", lots=1, open_price=2000, open_time=datetime(2024, 1, 1),
        contract_size=100, point_size=0.01, sl=1995.0, tp=2010.0,
    )
    positions = {"p1": pos}
    # bar's range covers both SL and TP
    b = bar(datetime(2024, 1, 1, 0, 1), 2000, 2015, 1990, 2000, spread=0)
    closed = engine.process_m1_bar(positions, b, default_spread_points=0)
    assert closed[0].close_reason == "sl"
    assert closed[0].close_price == pytest.approx(1995.0)


def test_gap_open_below_sl_fills_at_open_not_sl():
    pos = engine.EnginePosition(
        id="p1", side="buy", lots=1, open_price=2000, open_time=datetime(2024, 1, 1),
        contract_size=100, point_size=0.01, sl=1995.0, tp=2010.0,
    )
    positions = {"p1": pos}
    # bar opens already below SL (gap down)
    b = bar(datetime(2024, 1, 1, 0, 1), 1990, 1991, 1985, 1988, spread=0)
    closed = engine.process_m1_bar(positions, b, default_spread_points=0)
    assert closed[0].close_reason == "sl"
    assert closed[0].close_price == pytest.approx(1990.0)  # filled at open, not 1995


def test_gap_open_above_tp_fills_at_open():
    pos = engine.EnginePosition(
        id="p1", side="buy", lots=1, open_price=2000, open_time=datetime(2024, 1, 1),
        contract_size=100, point_size=0.01, sl=1995.0, tp=2010.0,
    )
    positions = {"p1": pos}
    b = bar(datetime(2024, 1, 1, 0, 1), 2020, 2025, 2018, 2022, spread=0)
    closed = engine.process_m1_bar(positions, b, default_spread_points=0)
    assert closed[0].close_reason == "tp"
    assert closed[0].close_price == pytest.approx(2020.0)


def test_short_position_sl_tp_use_ask_side():
    # short: sl above entry, tp below entry. Exit uses ask = bid+spread.
    pos = engine.EnginePosition(
        id="p1", side="sell", lots=1, open_price=2000, open_time=datetime(2024, 1, 1),
        contract_size=100, point_size=0.01, sl=2005.0, tp=1990.0,
    )
    positions = {"p1": pos}
    # bid high=2004.9 -> ask high = 2004.9+0.20=2005.1 >= sl(2005) -> hit
    b = bar(datetime(2024, 1, 1, 0, 1), 2000, 2004.9, 1999, 2002, spread=20)
    closed = engine.process_m1_bar(positions, b, default_spread_points=20)
    assert closed[0].close_reason == "sl"
    assert closed[0].close_price == pytest.approx(2005.0)


def test_short_tp_uses_ask_low():
    pos = engine.EnginePosition(
        id="p1", side="sell", lots=1, open_price=2000, open_time=datetime(2024, 1, 1),
        contract_size=100, point_size=0.01, sl=2010.0, tp=1990.0,
    )
    positions = {"p1": pos}
    # bid low = 1989.85 -> ask low = 1989.85+0.20=1990.05, NOT <= 1990 -> no hit
    b_no_hit = bar(datetime(2024, 1, 1, 0, 1), 2000, 2001, 1989.85, 1995, spread=20)
    closed = engine.process_m1_bar(dict(positions), b_no_hit, default_spread_points=20)
    assert closed == []

    # bid low = 1989.79 -> ask low = 1989.99 <= 1990 -> hit
    b_hit = bar(datetime(2024, 1, 1, 0, 1), 2000, 2001, 1989.79, 1995, spread=20)
    closed = engine.process_m1_bar(positions, b_hit, default_spread_points=20)
    assert closed[0].close_reason == "tp"
    assert closed[0].close_price == pytest.approx(1990.0)


def test_manual_close_uses_exit_side_price():
    pos = engine.open_market_position(
        bar(datetime(2024, 1, 1), 2000, 2000.5, 1999.5, 2000.0, spread=20),
        "buy", lots=1, contract_size=100, point_size=0.01, default_spread_points=20,
    )
    close_bar = bar(datetime(2024, 1, 1, 0, 5), 2005, 2006, 2004, 2005.5, spread=20)
    trade = engine.close_position_manually(pos, close_bar, default_spread_points=20)
    assert trade.close_reason == "manual"
    assert trade.close_price == pytest.approx(2005.5)  # buy exits at bid, no spread added
    expected_pnl = (2005.5 - pos.open_price) * 1 * 100
    assert trade.pnl == pytest.approx(expected_pnl)


def test_multiple_simultaneous_positions_independent():
    positions = {
        "a": engine.EnginePosition(id="a", side="buy", lots=1, open_price=2000, open_time=datetime(2024, 1, 1),
                                    contract_size=100, point_size=0.01, sl=1995, tp=None),
        "b": engine.EnginePosition(id="b", side="sell", lots=1, open_price=2000, open_time=datetime(2024, 1, 1),
                                    contract_size=100, point_size=0.01, sl=None, tp=1990),
    }
    b = bar(datetime(2024, 1, 1, 0, 1), 2000, 2001, 1989, 1992, spread=0)
    closed = engine.process_m1_bar(positions, b, default_spread_points=0)
    reasons = {c.position_id: c.close_reason for c in closed}
    assert reasons == {"a": "sl", "b": "tp"}
    assert positions == {}

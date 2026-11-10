"""Tests for replay smoothness fixes and features added on top of the MVP:
gap skipping, incremental candles for a display timeframe, pending orders,
invalid-stop rejection, symbol presets and extended statistics."""
import io
from datetime import datetime, timedelta

from fastapi.testclient import TestClient

from app.engine import engine
from app.engine.models import Bar, EnginePendingOrder
from app.engine.stats import compute_stats
from app.main import app

client = TestClient(app)


def _csv(rows: list[tuple[datetime, float, float, float, float]]) -> bytes:
    lines = ["time,open,high,low,close,volume,spread"]
    for ts, o, h, l, c in rows:
        lines.append(f"{ts.isoformat()},{o},{h},{l},{c},10,20")
    return ("\n".join(lines) + "\n").encode()


def _flat_rows(start: datetime, minutes: int, price=2000.0):
    return [(start + timedelta(minutes=i), price, price + 1, price - 1, price) for i in range(minutes)]


def _import(symbol: str, rows) -> None:
    resp = client.post(
        "/api/import/upload",
        files={"file": (f"{symbol}.csv", io.BytesIO(_csv(rows)), "text/csv")},
        data={"symbol": symbol},
    )
    assert resp.status_code == 200, resp.text


def _session(symbol: str, start: datetime) -> str:
    resp = client.post("/api/sessions", json={"symbol": symbol, "start_time": start.isoformat(), "starting_balance": 10000})
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def test_single_step_skips_data_gap_instead_of_stalling():
    t0 = datetime(2024, 1, 5, 21, 0)
    rows = _flat_rows(t0, 10)  # Friday 21:00-21:09
    rows += _flat_rows(datetime(2024, 1, 8, 0, 0), 10)  # Monday 00:00-
    _import("GAPSYM", rows)
    sid = _session("GAPSYM", datetime(2024, 1, 5, 21, 9))
    resp = client.post(f"/api/sessions/{sid}/step", json={"tf": "M1", "n": 1})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["cursor_time"].startswith("2024-01-08T00:00")
    assert data["end_of_data"] is False


def test_step_returns_all_changed_display_candles():
    _import("DISPSYM", _flat_rows(datetime(2024, 1, 1), 300))
    sid = _session("DISPSYM", datetime(2024, 1, 1, 0, 30))
    # 100 M1 steps while viewing H1: crosses one H1 boundary -> 2 H1 candles change
    resp = client.post(f"/api/sessions/{sid}/step", json={"tf": "M1", "n": 100, "display_tf": "H1"})
    data = resp.json()
    assert data["display_tf"] == "H1"
    hours = [datetime.utcfromtimestamp(c["timestamp"] / 1000).hour for c in data["candles"]]
    assert hours == [0, 1, 2]
    assert data["quote"]["bid"] == 2000.0
    # M1 display: every new bar is returned (not just the last 2)
    resp = client.post(f"/api/sessions/{sid}/step", json={"tf": "M1", "n": 20})
    assert len(resp.json()["candles"]) == 21  # previous cursor bar + 20 new


def test_invalid_timeframe_is_400():
    _import("TFSYM", _flat_rows(datetime(2024, 1, 1), 10))
    sid = _session("TFSYM", datetime(2024, 1, 1))
    assert client.post(f"/api/sessions/{sid}/step", json={"tf": "M7"}).status_code == 400
    assert client.get(f"/api/sessions/{sid}/bars", params={"tf": "X"}).status_code == 400


def test_inverted_stop_loss_is_rejected():
    _import("STOPSYM", _flat_rows(datetime(2024, 1, 1), 20))
    sid = _session("STOPSYM", datetime(2024, 1, 1, 0, 5))
    bad = client.post(f"/api/sessions/{sid}/orders", json={"side": "buy", "lots": 1, "sl": 2005.0})
    assert bad.status_code == 400
    ok = client.post(f"/api/sessions/{sid}/orders", json={"side": "buy", "lots": 1, "sl": 1990.0, "tp": 2010.0})
    assert ok.status_code == 200, ok.text
    pid = ok.json()["id"]
    bad_mod = client.put(f"/api/sessions/{sid}/positions/{pid}", json={"tp": 1980.0})
    assert bad_mod.status_code == 400


def test_pending_buy_limit_fills_and_then_hits_tp():
    t0 = datetime(2024, 1, 1)
    rows = _flat_rows(t0, 5, 2000.0)
    rows.append((t0 + timedelta(minutes=5), 1998.0, 1998.5, 1994.0, 1995.0))  # dips to the limit
    rows.append((t0 + timedelta(minutes=6), 1995.0, 2006.0, 1995.0, 2005.0))  # rallies through TP
    rows += _flat_rows(t0 + timedelta(minutes=7), 5, 2005.0)
    _import("LIMSYM", rows)
    sid = _session("LIMSYM", t0 + timedelta(minutes=4))

    resp = client.post(
        f"/api/sessions/{sid}/orders",
        json={"side": "buy", "lots": 1, "order_type": "limit", "price": 1995.0, "tp": 2004.0},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["order_type"] == "limit"
    assert len(client.get(f"/api/sessions/{sid}/orders").json()) == 1

    step = client.post(f"/api/sessions/{sid}/step", json={"tf": "M1", "n": 1}).json()
    assert [e["type"] for e in step["events"]] == ["filled"]
    # spread 20 points * 0.01 = 0.2 -> ask low = 1994.2 <= 1995 -> fills at limit price
    assert step["positions"][0]["open_price"] == 1995.0
    assert step["orders"] == []

    step = client.post(f"/api/sessions/{sid}/step", json={"tf": "M1", "n": 1}).json()
    assert [e["type"] for e in step["events"]] == ["closed"]
    assert step["events"][0]["trade"]["close_reason"] == "tp"
    assert step["events"][0]["trade"]["id"]  # persisted trade, not an engine object
    assert step["balance"] > 10000


def test_pending_order_validation_and_cancel():
    _import("PENDSYM", _flat_rows(datetime(2024, 1, 1), 20))
    sid = _session("PENDSYM", datetime(2024, 1, 1, 0, 5))
    # buy limit above the market is invalid (would be a buy stop)
    bad = client.post(f"/api/sessions/{sid}/orders", json={"side": "buy", "lots": 1, "order_type": "limit", "price": 2050})
    assert bad.status_code == 400
    ok = client.post(f"/api/sessions/{sid}/orders", json={"side": "sell", "lots": 1, "order_type": "stop", "price": 1980})
    assert ok.status_code == 200, ok.text
    oid = ok.json()["id"]
    moved = client.put(f"/api/sessions/{sid}/orders/{oid}", json={"price": 1970})
    assert moved.json()["price"] == 1970
    assert client.delete(f"/api/sessions/{sid}/orders/{oid}").json()["status"] == "cancelled"
    assert client.get(f"/api/sessions/{sid}/orders").json() == []


def test_pending_order_never_fills_on_bars_before_it_was_placed():
    order = EnginePendingOrder(
        id="x", side="sell", order_type="limit", price=2000.0, lots=1, created_time=datetime(2024, 1, 1, 0, 10)
    )
    earlier = Bar(datetime(2024, 1, 1, 0, 9), 2001, 2005, 1999, 2002)
    later = Bar(datetime(2024, 1, 1, 0, 11), 1999, 2001, 1998, 1999.5)
    assert engine.check_pending_trigger(order, earlier, 20, 0.01) is None
    assert engine.check_pending_trigger(order, later, 20, 0.01) == 2000.0


def test_stop_order_gap_fills_at_open():
    order = EnginePendingOrder(
        id="x", side="buy", order_type="stop", price=2000.0, lots=1, created_time=datetime(2024, 1, 1)
    )
    gap_bar = Bar(datetime(2024, 1, 1, 0, 1), 2010, 2012, 2009, 2011, spread=0)
    assert engine.check_pending_trigger(order, gap_bar, 0, 0.01) == 2010


def test_symbol_presets_for_fx():
    _import("EURUSD", [(datetime(2024, 1, 1) + timedelta(minutes=i), 1.1, 1.1001, 1.0999, 1.1) for i in range(5)])
    cfg = next(s for s in client.get("/api/symbols").json() if s["name"] == "EURUSD")
    assert cfg["point_size"] == 0.00001
    assert cfg["contract_size"] == 100000


def test_symbol_config_validation():
    _import("CFGSYM", _flat_rows(datetime(2024, 1, 1), 5))
    assert client.put("/api/symbols/CFGSYM", json={"point_size": 0}).status_code == 400
    assert client.put("/api/symbols/CFGSYM", json={"timezone": "Not/AZone"}).status_code == 400
    assert client.put("/api/symbols/CFGSYM", json={"timezone": "Europe/Istanbul"}).status_code == 200


class _T:
    def __init__(self, pnl, side="buy", i=0):
        self.side, self.lots, self.open_price, self.close_price = side, 1.0, 100.0, 100.0
        self.sl, self.pnl, self.contract_size = None, pnl, 1.0
        self.close_time = datetime(2024, 1, 1) + timedelta(minutes=i)


def test_extended_stats():
    trades = [_T(100, i=0), _T(-50, "sell", 1), _T(-30, "sell", 2), _T(200, i=3)]
    s = compute_stats(trades, 1000)
    assert s.expectancy == 55
    assert s.largest_win == 200 and s.largest_loss == -50
    assert s.max_consecutive_losses == 2 and s.max_consecutive_wins == 1
    assert s.return_pct == 22
    assert s.long_trades == 2 and s.long_win_rate == 100 and s.short_win_rate == 0
    assert round(s.max_drawdown_pct, 4) == round(80 / 1100 * 100, 4)

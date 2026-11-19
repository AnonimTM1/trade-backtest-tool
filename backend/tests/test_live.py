"""Live (MT5) paper-trading mode, against a fake bridge."""
import pytest
from fastapi.testclient import TestClient

from app.data import mt5_client
from app.main import app

client = TestClient(app)

T0 = 1_790_000_000_000  # UTC ms


class FakeBridge:
    def __init__(self):
        self.now = T0
        self.bid = 2000.00
        self.spread = 0.20
        self.history: list[list[float]] = []  # [ms, bid, ask]
        self.down = False

    def move(self, *bids, step_ms=250):
        for b in bids:
            self.now += step_ms
            self.bid = b
            self.history.append([self.now, b, round(b + self.spread, 2)])

    # --- mt5_client API ---
    def _check(self):
        if self.down:
            raise mt5_client.BridgeUnavailable("bridge down")

    def symbol_info(self, name):
        self._check()
        if name != "XAUUSD":
            raise mt5_client.BridgeRequestError(404, f"Unknown MT5 symbol {name!r}")
        return {"name": name, "point": 0.01, "contract_size": 100.0, "spread": 20, "digits": 2}

    def tick(self, name):
        self.symbol_info(name)
        return {"time_ms": self.now, "bid": self.bid, "ask": round(self.bid + self.spread, 2)}

    def ticks(self, name, from_ms, to_ms):
        self._check()
        return [t for t in self.history if from_ms < t[0] <= to_ms]

    def rates(self, name, tf, count, before_ms=None, timeout=None):
        self._check()
        return [{"timestamp": self.now - self.now % 60000, "open": 2000, "high": self.bid + 1, "low": 1999,
                 "close": self.bid, "volume": 10, "spread": 20}][:count]


@pytest.fixture
def bridge(monkeypatch):
    fb = FakeBridge()
    for name in ("symbol_info", "tick", "ticks", "rates"):
        monkeypatch.setattr(mt5_client, name, getattr(fb, name))
    return fb


def _live_session(balance=10000.0) -> str:
    r = client.post("/api/live/sessions", json={"symbol": "XAUUSD", "starting_balance": balance, "name": "L"})
    assert r.status_code == 200, r.text
    assert r.json()["symbol"] == "MT5:XAUUSD"
    return r.json()["id"]


def _sync(sid, tf="M1"):
    r = client.post(f"/api/sessions/{sid}/live/sync", json={"display_tf": tf})
    assert r.status_code == 200, r.text
    return r.json()


def test_market_order_fills_at_live_ask_and_bid(bridge):
    sid = _live_session()
    buy = client.post(f"/api/sessions/{sid}/orders", json={"side": "buy", "lots": 1}).json()
    assert buy["open_price"] == pytest.approx(2000.20)
    sell = client.post(f"/api/sessions/{sid}/orders", json={"side": "sell", "lots": 1}).json()
    assert sell["open_price"] == pytest.approx(2000.00)
    state = _sync(sid)
    assert state["quote"]["bid"] == pytest.approx(2000.00)
    assert state["quote"]["ask"] == pytest.approx(2000.20)
    assert state["live"]["ok"] is True
    assert state["candles"] and state["candles"][0]["close"] == pytest.approx(2000.00)


def test_take_profit_hit_between_polls_is_not_missed(bridge):
    sid = _live_session()
    pos = client.post(f"/api/sessions/{sid}/orders", json={"side": "buy", "lots": 1, "tp": 2003.0, "sl": 1990.0}).json()
    # price spikes through TP and comes back down before the next poll
    bridge.move(2001.0, 2003.5, 2001.0)
    state = _sync(sid)
    closed = [e for e in state["events"] if e["type"] == "closed"]
    assert len(closed) == 1 and closed[0]["trade"]["position_id"] == pos["id"]
    assert closed[0]["trade"]["close_reason"] == "tp"
    assert closed[0]["trade"]["pnl"] == pytest.approx((2003.0 - 2000.20) * 100)
    assert state["positions"] == []
    assert state["balance"] == pytest.approx(10000 + (2003.0 - 2000.20) * 100)


def test_pending_limit_order_fills_from_ticks(bridge):
    sid = _live_session()
    r = client.post(f"/api/sessions/{sid}/orders", json={"side": "buy", "lots": 1, "order_type": "limit", "price": 1998.0})
    assert r.status_code == 200, r.text
    bridge.move(1999.0, 1997.7, 1999.5)
    state = _sync(sid)
    assert [e["type"] for e in state["events"]] == ["filled"]
    assert len(state["positions"]) == 1
    assert state["orders"] == []


def test_replay_controls_are_rejected_for_live_sessions(bridge):
    sid = _live_session()
    r = client.post(f"/api/sessions/{sid}/step", json={"tf": "M1", "n": 1})
    assert r.status_code == 400
    assert "Live sessions" in r.json()["detail"]


def test_bridge_down_is_reported_not_crashing(bridge):
    sid = _live_session()
    bridge.down = True
    state = _sync(sid)
    assert state["live"]["ok"] is False and "bridge down" in state["live"]["error"]
    assert state["quote"] is None
    r = client.post(f"/api/sessions/{sid}/orders", json={"side": "buy", "lots": 1})
    assert r.status_code == 503
    assert client.get("/api/sessions").status_code == 200  # listing still works


def test_unknown_symbol_and_bars_endpoint(bridge):
    r = client.post("/api/live/sessions", json={"symbol": "NOPE", "starting_balance": 100})
    assert r.status_code == 404
    sid = _live_session()
    bars = client.get(f"/api/sessions/{sid}/bars", params={"tf": "M5", "limit": 10}).json()
    assert bars["candles"][0]["close"] == pytest.approx(2000.0)


def test_busy_mt5_is_not_reported_as_disconnected(bridge, monkeypatch):
    """While MT5 downloads history, candle requests time out: the quote must
    still come through and the session must stay 'connected (busy)'."""
    sid = _live_session()

    def slow_rates(*a, **k):
        raise mt5_client.BridgeRequestError(504, "MetaTrader 5 is busy")

    monkeypatch.setattr(mt5_client, "rates", slow_rates)
    state = _sync(sid)
    assert state["live"] == {"ok": True, "busy": True, "error": None}
    assert state["quote"]["bid"] == pytest.approx(2000.0)


def test_timeout_does_not_mark_bridge_down(monkeypatch):
    import socket
    import urllib.error

    def timeout(url, timeout):
        raise urllib.error.URLError(socket.timeout("timed out"))

    monkeypatch.setattr(mt5_client.urllib.request, "urlopen", timeout)
    with pytest.raises(mt5_client.BridgeRequestError) as e:
        mt5_client._get("/tick", symbol="XAUUSD")
    assert e.value.status == 504 and mt5_client.is_busy(e.value)
    assert mt5_client._down_until < __import__("time").time()  # next call is not short-circuited

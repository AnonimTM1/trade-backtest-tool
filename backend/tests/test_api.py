import io
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _make_csv(symbol_minutes: int, start=datetime(2024, 1, 1), base=2000.0) -> bytes:
    lines = ["time,open,high,low,close,volume,spread"]
    price = base
    for i in range(symbol_minutes):
        ts = start + timedelta(minutes=i)
        o = price
        h = price + 1.0
        l = price - 1.0
        c = price + 0.2
        lines.append(f"{ts.isoformat()},{o},{h},{l},{c},10,20")
        price = c
    return ("\n".join(lines) + "\n").encode()


def _import_symbol(symbol: str, minutes=300):
    csv_bytes = _make_csv(minutes)
    resp = client.post(
        "/api/import/upload",
        files={"file": (f"{symbol}.csv", io.BytesIO(csv_bytes), "text/csv")},
        data={"symbol": symbol},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_health():
    assert client.get("/api/health").json() == {"status": "ok"}


def test_import_and_list_symbols():
    _import_symbol("APITESTSYM1")
    resp = client.get("/api/symbols")
    assert resp.status_code == 200
    names = [s["name"] for s in resp.json()]
    assert "APITESTSYM1" in names


def test_session_bars_never_after_cursor():
    _import_symbol("APITESTSYM2", minutes=300)
    start = datetime(2024, 1, 1, 0, 0).isoformat()
    resp = client.post("/api/sessions", json={"symbol": "APITESTSYM2", "start_time": start, "starting_balance": 10000})
    assert resp.status_code == 200, resp.text
    session = resp.json()

    # step forward 50 M1 bars
    resp = client.post(f"/api/sessions/{session['id']}/step", json={"tf": "M1", "n": 50})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    cursor_ms = _iso_to_ms(data["cursor_time"])
    for c in data["candles"]:
        assert c["timestamp"] <= cursor_ms

    # fetch bars directly too
    resp2 = client.get(f"/api/sessions/{session['id']}/bars", params={"tf": "H1", "limit": 50})
    for c in resp2.json()["candles"]:
        assert c["timestamp"] <= cursor_ms


def _iso_to_ms(iso: str) -> int:
    import pandas as pd
    return int(pd.Timestamp(iso).timestamp() * 1000)


def test_repeated_single_m1_steps_actually_advance_cursor():
    """Regression test: step_forward's bucket-boundary math must advance the
    cursor by exactly one bar per step at the base (M1) timeframe — this is
    what drives Play mode, which previously never progressed at all because
    the bucket cutoff excluded the very next bar for tf == M1."""
    _import_symbol("APITESTSTEPADV", minutes=200)
    start = datetime(2024, 1, 1, 0, 0).isoformat()
    session = client.post("/api/sessions", json={"symbol": "APITESTSTEPADV", "start_time": start}).json()
    sid = session["id"]

    cursors = [session["cursor_time"]]
    for _ in range(20):
        resp = client.post(f"/api/sessions/{sid}/step", json={"tf": "M1", "n": 1})
        assert resp.status_code == 200, resp.text
        cursors.append(resp.json()["cursor_time"])

    timestamps = [_iso_to_ms(c) for c in cursors]
    assert len(set(timestamps)) == len(timestamps), f"cursor did not advance every step: {cursors}"
    diffs = [b - a for a, b in zip(timestamps, timestamps[1:])]
    assert all(d == 60_000 for d in diffs), f"expected exactly 1 minute per step, got diffs {diffs}"


def test_step_forward_n_bars_lands_exactly_n_minutes_later_for_m1():
    _import_symbol("APITESTSTEPN", minutes=200)
    start = datetime(2024, 1, 1, 0, 0).isoformat()
    session = client.post("/api/sessions", json={"symbol": "APITESTSTEPN", "start_time": start}).json()
    sid = session["id"]
    start_ms = _iso_to_ms(session["cursor_time"])

    resp = client.post(f"/api/sessions/{sid}/step", json={"tf": "M1", "n": 5})
    new_ms = _iso_to_ms(resp.json()["cursor_time"])
    assert new_ms - start_ms == 5 * 60_000


def test_step_forward_h1_completes_partial_bucket_then_full_bucket():
    _import_symbol("APITESTSTEPH1", minutes=200)
    start = datetime(2024, 1, 1, 0, 0).isoformat()
    session = client.post("/api/sessions", json={"symbol": "APITESTSTEPH1", "start_time": start}).json()
    sid = session["id"]

    # advance 29 M1 bars first, landing mid-way through the first H1 bucket
    client.post(f"/api/sessions/{sid}/step", json={"tf": "M1", "n": 29})
    resp = client.post(f"/api/sessions/{sid}/step", json={"tf": "H1", "n": 1})
    cursor = resp.json()["cursor_time"]
    assert cursor == "2024-01-01T00:59:00"

    resp2 = client.post(f"/api/sessions/{sid}/step", json={"tf": "H1", "n": 1})
    cursor2 = resp2.json()["cursor_time"]
    assert cursor2 == "2024-01-01T01:59:00"


def test_order_fill_and_close():
    _import_symbol("APITESTSYM3", minutes=200)
    start = datetime(2024, 1, 1, 0, 0).isoformat()
    session = client.post("/api/sessions", json={"symbol": "APITESTSYM3", "start_time": start}).json()
    sid = session["id"]

    resp = client.post(f"/api/sessions/{sid}/orders", json={"side": "buy", "lots": 1, "sl": 1990, "tp": 2100})
    assert resp.status_code == 200, resp.text
    position = resp.json()
    assert position["side"] == "buy"

    positions = client.get(f"/api/sessions/{sid}/positions").json()
    assert len(positions) == 1

    # step back should be blocked while position open
    resp = client.post(f"/api/sessions/{sid}/step_back", json={"tf": "M1", "n": 1})
    assert resp.status_code == 409

    resp = client.post(f"/api/sessions/{sid}/positions/{position['id']}/close")
    assert resp.status_code == 200, resp.text
    trade = resp.json()
    assert trade["close_reason"] == "manual"

    trades = client.get(f"/api/sessions/{sid}/trades").json()
    assert len(trades) == 1

    stats = client.get(f"/api/sessions/{sid}/stats").json()
    assert stats["total_trades"] == 1


def test_drawings_crud_and_persistence():
    _import_symbol("APITESTSYM4", minutes=50)
    resp = client.post(
        "/api/symbols/APITESTSYM4/drawings",
        json={"overlay_name": "segment", "points": [{"timestamp": 1000, "value": 2000}, {"timestamp": 2000, "value": 2010}]},
    )
    assert resp.status_code == 200, resp.text
    drawing = resp.json()
    assert drawing["id"]

    listed = client.get("/api/symbols/APITESTSYM4/drawings").json()
    assert len(listed) == 1

    resp = client.delete(f"/api/symbols/APITESTSYM4/drawings/{drawing['id']}")
    assert resp.status_code == 200
    listed2 = client.get("/api/symbols/APITESTSYM4/drawings").json()
    assert len(listed2) == 0


def test_reject_bad_csv_with_clear_error():
    resp = client.post(
        "/api/import/upload",
        files={"file": ("bad.csv", io.BytesIO(b"not,a,valid,header\n1,2,3,4\n"), "text/csv")},
    )
    assert resp.status_code == 400
    assert "Failed to parse" in resp.json()["detail"]

from datetime import datetime

from fastapi.testclient import TestClient

from app.api import import_ as import_module
from app.data import dukascopy
from app.main import app

client = TestClient(app)


async def _fake_download_m1_range(symbol, date_from, date_to, point_size, pipet_scale=None, on_progress=None):
    rows = []
    for i in range(5):
        rows.append(
            {
                "timestamp": datetime(2024, 1, 1, 0, i),
                "open": 2000.0 + i,
                "high": 2000.5 + i,
                "low": 1999.5 + i,
                "close": 2000.2 + i,
                "volume": 10.0,
                "spread": 20.0,
            }
        )
    if on_progress:
        on_progress(1, 1)
    return rows


def test_download_job_runs_and_imports(monkeypatch):
    monkeypatch.setattr(dukascopy, "download_m1_range", _fake_download_m1_range)
    monkeypatch.setattr(import_module.dukascopy, "download_m1_range", _fake_download_m1_range)

    resp = client.post(
        "/api/import/download",
        json={"symbol": "XAUUSD", "date_from": "2024-01-01T00:00:00", "date_to": "2024-01-01T01:00:00"},
    )
    assert resp.status_code == 200, resp.text
    job = resp.json()
    assert job["status"] == "pending"  # background task hasn't run at response-serialization time

    # By the time the TestClient call returns, the background task has already
    # executed (it runs within the same synchronous request lifecycle), so a
    # follow-up GET should reflect the finished job.
    job2 = client.get(f"/api/import/download/{job['id']}").json()
    assert job2["status"] == "done"
    assert job2["rows_imported"] == 5

    symbols = client.get("/api/symbols").json()
    assert any(s["name"] == "XAUUSD" and s["has_data"] for s in symbols)


def test_unsupported_symbol_rejected_without_scale():
    resp = client.post(
        "/api/import/download",
        json={"symbol": "NOTREAL", "date_from": "2024-01-01T00:00:00", "date_to": "2024-01-01T01:00:00"},
    )
    assert resp.status_code == 400


def test_dukascopy_symbols_list():
    resp = client.get("/api/import/dukascopy/symbols")
    assert resp.status_code == 200
    assert "XAUUSD" in resp.json()["symbols"]


def test_bad_date_range_rejected():
    resp = client.post(
        "/api/import/download",
        json={"symbol": "XAUUSD", "date_from": "2024-01-02T00:00:00", "date_to": "2024-01-01T00:00:00"},
    )
    assert resp.status_code == 400

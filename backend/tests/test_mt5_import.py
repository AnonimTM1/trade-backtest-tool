"""MT5 history import into the offline store, and the auto-update pass."""
from datetime import datetime, timedelta

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.data import mt5_client, mt5_import, parquet_store
from app.main import app

client = TestClient(app)


class FakeMt5:
    """Serves one M1 bar per minute between `first` and now (like an MT5 history limit)."""

    def __init__(self, first: datetime):
        self.first = first
        self.calls = []

    def rates_range(self, name, tf, from_ms, to_ms):
        self.calls.append((from_ms, to_ms))
        lo = max(pd.Timestamp(from_ms, unit="ms"), pd.Timestamp(self.first))
        hi = pd.Timestamp(to_ms, unit="ms")
        out = []
        t = lo.ceil("min")
        while t < hi:
            ms = int(t.value // 1_000_000)
            out.append({"timestamp": ms, "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.5, "volume": 5.0, "spread": 12.0})
            t += pd.Timedelta(minutes=1)
        return out

    def symbol_info(self, name):
        return {"name": name, "point": 0.001, "contract_size": 100000.0, "spread": 12}

    def status(self):
        return {"connected": True, "bridge": True}


@pytest.fixture
def mt5(monkeypatch, tmp_path):
    fake = FakeMt5(first=datetime(2024, 3, 1))
    for name in ("rates_range", "symbol_info", "status"):
        monkeypatch.setattr(mt5_client, name, getattr(fake, name))
    monkeypatch.setattr(mt5_import, "AUTOSYNC_FILE", tmp_path / "mt5_autosync.json")
    return fake


def test_import_is_chunked_and_merged(mt5):
    res = mt5_import.import_range("EURJPYm", "EURJPYM_T1", datetime(2024, 3, 1), datetime(2024, 3, 1, 0, 0) + timedelta(days=30))
    assert len(mt5.calls) == 3  # 30 days in 14-day chunks
    assert res["rows"] == 30 * 1440
    m1 = parquet_store.load_m1("EURJPYM_T1")
    assert len(m1) == 30 * 1440 and m1["spread"].iloc[0] == 12.0
    # importing an overlapping range again doesn't duplicate bars
    mt5_import.import_range("EURJPYm", "EURJPYM_T1", datetime(2024, 3, 20), datetime(2024, 4, 5))
    assert len(parquet_store.load_m1("EURJPYM_T1")) == 35 * 1440


def test_history_limit_warning():
    assert mt5_import.history_warning(datetime(2024, 1, 1), datetime(2024, 1, 2)) is None  # a weekend's gap is fine
    warn = mt5_import.history_warning(datetime(2023, 1, 1), datetime(2024, 3, 1))
    assert "Max bars in chart" in warn and "2024-03-01" in warn
    assert "no bars" in mt5_import.history_warning(datetime(2024, 1, 1), None)


def test_import_endpoint_runs_job_and_registers_autosync(mt5):
    r = client.post("/api/import/mt5", json={
        "broker_symbol": "GBPJPY.r", "date_from": "2024-02-01T00:00:00", "date_to": "2024-03-03T00:00:00", "keep_updated": True,
    })
    assert r.status_code == 200, r.text
    job = client.get(f"/api/import/download/{r.json()['id']}").json()
    assert job["status"] == "done" and job["symbol"] == "GBPJPY.R"
    assert job["rows_imported"] == 2 * 1440
    assert "Max bars in chart" in job["error_message"]  # asked from Feb 1, MT5 had data from Mar 1
    cfg = client.get("/api/symbols/GBPJPY.R/config").json()
    assert cfg["point_size"] == 0.001 and cfg["contract_size"] == 100000.0 and cfg["has_data"]
    assert [s["symbol"] for s in client.get("/api/import/mt5/autosync").json()["symbols"]] == ["GBPJPY.R"]


def test_autosync_only_fetches_new_bars(mt5, monkeypatch):
    mt5.first = datetime(2000, 1, 1)
    now = pd.Timestamp.utcnow().tz_localize(None).floor("min").to_pydatetime()
    mt5_import.import_range("USDJPY", "USDJPY_T2", now - timedelta(hours=3), now - timedelta(hours=1))
    mt5_import.set_autosync("USDJPY_T2", "USDJPY", True)
    mt5.calls.clear()
    out = mt5_import.sync_all()
    assert out["ran"] and out["results"]["USDJPY_T2"] >= 60  # the last hour, not the whole history again
    (from_ms, _), = mt5.calls
    assert pd.Timestamp(from_ms, unit="ms") == pd.Timestamp(now - timedelta(hours=1))
    assert mt5_import.autosync_list()[0]["last_sync"] is not None
    client.delete("/api/import/mt5/autosync/USDJPY_T2")
    assert mt5_import.autosync_list() == []

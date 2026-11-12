import io
from datetime import datetime, timedelta

from fastapi.testclient import TestClient

from app.data import news
from app.main import app

client = TestClient(app)

CSV = """Date,Time,Day,Currency,Impact,Event,Actual,Forecast,Previous,Time_Label,Event_ID
2024-01-05,13:30,Friday,USD,High,Non-Farm Employment Change,216K,168K,173K,,1
2024-07-05,13:30,Friday,USD,High,Non-Farm Employment Change,206K,191K,218K,,2
2024-07-05,09:00,Friday,EUR,Medium,German Factory Orders,1.0%,0.5%,0.2%,,3
2024-07-05,10:00,Friday,USD,Low,Some Low Event,1,1,1,,4
2024-07-04,,Thursday,USD,Non-Economic,Bank Holiday,,,,All Day,5
"""


def _upload():
    r = client.post("/api/news/upload", files={"file": ("ff.csv", io.BytesIO(CSV.encode()), "text/csv")})
    assert r.status_code == 200, r.text
    return r.json()


def _session(symbol: str, start: datetime) -> str:
    lines = ["time,open,high,low,close,volume,spread"]
    for i in range(60 * 24 * 3):
        ts = start + timedelta(minutes=i)
        lines.append(f"{ts.isoformat()},2000,2001,1999,2000,1,20")
    client.post("/api/import/upload", files={"file": (f"{symbol}.csv", io.BytesIO("\n".join(lines).encode()), "text/csv")},
                data={"symbol": symbol})
    r = client.post("/api/sessions", json={"symbol": symbol, "start_time": start.isoformat()})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_london_times_are_converted_to_utc():
    assert _upload()["count"] == 5
    df = news.load()
    nfp = df[df["event"] == "Non-Farm Employment Change"]["time"].dt.strftime("%Y-%m-%d %H:%M").tolist()
    # winter: London == UTC; summer: London == UTC+1
    assert nfp == ["2024-01-05 13:30", "2024-07-05 12:30"]
    assert bool(df[df["event"] == "Bank Holiday"]["all_day"].iloc[0])


def test_session_news_filters_and_hides_future_actuals():
    _upload()
    sid = _session("NEWSSYM", datetime(2024, 7, 5, 0, 0))  # cursor before NFP
    frm = int(datetime(2024, 7, 4).timestamp() * 1000)
    to = int(datetime(2024, 7, 6).timestamp() * 1000)
    # default impacts = High+Medium (the Low and Non-Economic rows are excluded)
    r = client.get(f"/api/sessions/{sid}/news", params={"from": frm, "to": to, "currencies": "USD,EUR"})
    events = r.json()["events"]
    assert [e["event"] for e in events] == ["German Factory Orders", "Non-Farm Employment Change"]
    assert all(e["actual"] is None and not e["released"] for e in events)

    # step the replay past the release -> actual revealed
    client.post(f"/api/sessions/{sid}/jump", json={"timestamp": "2024-07-05T12:30:00"})
    events = client.get(f"/api/sessions/{sid}/news", params={"from": frm, "to": to, "currencies": "all"}).json()["events"]
    nfp = next(e for e in events if e["event"] == "Non-Farm Employment Change")
    assert nfp["actual"] == "206K" and nfp["released"]


def test_symbol_currencies():
    assert news.symbol_currencies("XAUUSD") == ["USD"]
    assert news.symbol_currencies("EURUSD") == ["EUR", "USD"]
    assert news.symbol_currencies("GBPJPY") == ["GBP", "JPY"]


def test_bad_upload_rejected():
    r = client.post("/api/news/upload", files={"file": ("x.csv", io.BytesIO(b"a,b\n1,2\n"), "text/csv")})
    assert r.status_code == 400

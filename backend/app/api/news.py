from __future__ import annotations

import pandas as pd
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from sqlalchemy.orm import Session as DbSession

from app.data import news
from app.db.database import get_db
from app.db.models import ReplaySession

router = APIRouter(tags=["news"])

MAX_RANGE_DAYS = 3660


def _csv_list(value: str | None) -> list[str]:
    return [v.strip() for v in (value or "").split(",") if v.strip()]


@router.get("/api/news/status")
def news_status():
    try:
        return news.status()
    except Exception as e:  # a malformed file shouldn't take the endpoint down
        raise HTTPException(500, f"Failed to read news file: {e}") from e


@router.post("/api/news/upload")
async def upload_news(file: UploadFile = File(...)):
    raw = await file.read()
    try:
        count = news.save_upload(raw)
    except Exception as e:
        raise HTTPException(400, f"Not a valid ForexFactory calendar CSV: {e}") from e
    return {"ok": True, "count": count}


@router.get("/api/sessions/{session_id}/news")
def session_news(
    session_id: str,
    start: int = Query(..., alias="from", description="unix ms"),
    end: int = Query(..., alias="to", description="unix ms"),
    impacts: str = Query("High,Medium"),
    currencies: str | None = Query(None, description="comma list, 'all', or omitted for the symbol's currencies"),
    db: DbSession = Depends(get_db),
):
    session = db.get(ReplaySession, session_id)
    if session is None:
        raise HTTPException(404, "Session not found")
    start_ts = pd.Timestamp(start, unit="ms")
    end_ts = pd.Timestamp(end, unit="ms")
    if end_ts < start_ts:
        raise HTTPException(400, "'to' must be after 'from'")
    if end_ts - start_ts > pd.Timedelta(days=MAX_RANGE_DAYS):
        start_ts = end_ts - pd.Timedelta(days=MAX_RANGE_DAYS)

    default_ccy = news.symbol_currencies(session.symbol)
    if currencies is None:
        ccy = default_ccy + ["ALL"]  # "ALL" = global events (G20, OPEC...)
    elif currencies.lower() == "all":
        ccy = None
    else:
        ccy = [c.upper() for c in _csv_list(currencies)]
    imp = [i for i in _csv_list(impacts) if i in news.IMPACTS]

    try:
        events = news.query(start_ts, end_ts, imp, ccy, reveal_until=pd.Timestamp(session.cursor_time))
    except Exception as e:
        raise HTTPException(500, f"Failed to read news file: {e}") from e
    return {
        "loaded": news.load() is not None,
        "symbol_currencies": default_ccy,
        "events": events,
    }

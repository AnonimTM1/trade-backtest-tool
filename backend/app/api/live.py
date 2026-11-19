"""Live (MT5) mode: real-time prices from the MT5 bridge, paper trading only."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DbSession

from app.api import sessions_service
from app.api.sessions import _event_out, _get_session_or_404, _session_out, _state
from app.config import TIMEFRAMES
from app.data import mt5_client
from app.db.database import get_db

router = APIRouter(tags=["live"])


class LiveSessionCreate(BaseModel):
    symbol: str = Field(min_length=1, max_length=64)
    starting_balance: float = 10000.0
    name: str = "Live"


class LiveSyncRequest(BaseModel):
    display_tf: str = "M1"
    bars: int = Field(2, ge=1, le=50)


def _bridge_call(fn, *args):
    try:
        return fn(*args)
    except mt5_client.BridgeUnavailable as e:
        raise HTTPException(503, str(e)) from e
    except mt5_client.BridgeRequestError as e:
        raise HTTPException(e.status if e.status < 500 else 502, str(e)) from e


@router.get("/api/live/status")
def live_status():
    return mt5_client.status()


@router.get("/api/live/symbols")
def live_symbols():
    return {"symbols": _bridge_call(mt5_client.symbols)}


@router.post("/api/live/sessions")
def create_live_session(body: LiveSessionCreate, db: DbSession = Depends(get_db)):
    session = sessions_service.create_live_session(db, body.symbol, body.starting_balance, body.name)
    return _session_out(db, session)


@router.post("/api/sessions/{session_id}/live/sync")
def live_sync(session_id: str, body: LiveSyncRequest, db: DbSession = Depends(get_db)):
    """One poll of a live session: process every tick since the last poll
    (SL/TP, pending orders), then return the account state plus the newest
    bars of the displayed timeframe so the chart's forming candle updates."""
    session = _get_session_or_404(db, session_id)
    if not mt5_client.is_live(session.symbol):
        raise HTTPException(400, "Not a live session")
    if body.display_tf not in TIMEFRAMES:
        raise HTTPException(400, f"Unknown timeframe {body.display_tf!r}")
    events, ctx = sessions_service.live_sync(db, session)
    candles: list[dict] = []
    error = ctx.live_error
    busy = ctx.live_busy
    if error is None:
        try:
            candles = [
                {k: c[k] for k in ("timestamp", "open", "high", "low", "close", "volume")}
                for c in mt5_client.rates(
                    mt5_client.broker_symbol(session.symbol), body.display_tf, body.bars, timeout=mt5_client.TIMEOUT
                )
            ]
        except (mt5_client.BridgeUnavailable, mt5_client.BridgeRequestError) as e:
            if mt5_client.is_busy(e):
                busy = True  # quote is fine, the candle update just waits for the next poll
            else:
                error = str(e)
    return {
        **_state(db, session),
        "display_tf": body.display_tf,
        "candles": candles,
        "events": [_event_out(db, session, e, ctx) for e in events],
        "live": {"ok": error is None, "busy": busy, "error": error},
    }

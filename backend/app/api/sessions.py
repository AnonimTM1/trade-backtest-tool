from __future__ import annotations

import csv
import io

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.api import sessions_service
from app.api.schemas import (
    JumpRequest,
    OrderRequest,
    OrderUpdate,
    PositionUpdate,
    SessionCreate,
    SessionOut,
    StepRequest,
)
from app.data import resample
from app.db.database import get_db
from app.db.models import PendingOrder, Position, ReplaySession, Trade
from app.engine.stats import compute_stats

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


def _get_session_or_404(db: DbSession, session_id: str) -> ReplaySession:
    session = db.get(ReplaySession, session_id)
    if session is None:
        raise HTTPException(404, "Session not found")
    return session


def _session_out(db: DbSession, session: ReplaySession, ctx=None) -> SessionOut:
    ctx = ctx or sessions_service.cursor_context(db, session)
    equity, open_rows = sessions_service.session_equity(db, session, ctx)
    return SessionOut(
        id=session.id,
        name=session.name,
        symbol=session.symbol,
        start_time=session.start_time,
        cursor_time=session.cursor_time,
        starting_balance=session.starting_balance,
        balance=session.balance,
        equity=equity,
        has_open_positions=len(open_rows) > 0,
        created_at=session.created_at,
        updated_at=session.updated_at,
        quote=ctx.quote(),
    )


def _state(db: DbSession, session: ReplaySession) -> dict:
    """Everything the trading UI shows, in one round trip."""
    ctx = sessions_service.cursor_context(db, session)
    open_rows = sessions_service.get_open_positions(db, session.id)
    equity, _ = sessions_service.session_equity(db, session, ctx, open_rows)
    return {
        "cursor_time": session.cursor_time,
        "balance": session.balance,
        "equity": equity,
        "quote": ctx.quote(),
        "positions": [sessions_service.position_to_out(db, session, r, ctx) for r in open_rows],
        "orders": [sessions_service.order_to_out(o) for o in sessions_service.get_pending_orders(db, session.id)],
    }


@router.post("", response_model=SessionOut)
def create_session(body: SessionCreate, db: DbSession = Depends(get_db)):
    session = sessions_service.create_session(db, body.symbol, body.start_time, body.starting_balance, body.name)
    return _session_out(db, session)


@router.get("", response_model=list[SessionOut])
def list_sessions(db: DbSession = Depends(get_db)):
    sessions = db.execute(select(ReplaySession).order_by(ReplaySession.updated_at.desc())).scalars().all()
    return [_session_out(db, s) for s in sessions]


@router.get("/{session_id}", response_model=SessionOut)
def get_session(session_id: str, db: DbSession = Depends(get_db)):
    session = _get_session_or_404(db, session_id)
    return _session_out(db, session)


@router.get("/{session_id}/state")
def get_state(session_id: str, db: DbSession = Depends(get_db)):
    session = _get_session_or_404(db, session_id)
    return _state(db, session)


@router.delete("/{session_id}")
def delete_session(session_id: str, db: DbSession = Depends(get_db)):
    session = _get_session_or_404(db, session_id)
    db.query(Trade).filter(Trade.session_id == session_id).delete()
    db.query(Position).filter(Position.session_id == session_id).delete()
    db.query(PendingOrder).filter(PendingOrder.session_id == session_id).delete()
    db.delete(session)
    db.commit()
    return {"ok": True}


@router.get("/{session_id}/bars")
def get_session_bars(
    session_id: str,
    tf: str = Query("M1"),
    limit: int = Query(500, ge=1, le=5000),
    before: int | None = Query(None),
    db: DbSession = Depends(get_db),
):
    sessions_service.validate_tf(tf)
    session = _get_session_or_404(db, session_id)
    cfg = sessions_service.get_or_create_symbol_config(db, session.symbol)
    before_ts = pd.Timestamp(before, unit="ms") if before is not None else None
    cursor_ts = pd.Timestamp(session.cursor_time)
    df = resample.get_bars_upto_cursor(session.symbol, tf, cursor=cursor_ts, tz=cfg.timezone, before=before_ts, limit=limit)
    return {"symbol": session.symbol, "tf": tf, "cursor_time": session.cursor_time, "candles": sessions_service.df_to_candles(df)}


def _event_out(db, session, ev: dict, ctx) -> dict:
    if ev["type"] == "closed":
        return {"type": "closed", "trade": _trade_to_dict(ev["trade"])}
    return {
        "type": "filled",
        "order": sessions_service.order_to_out(ev["order"]),
        "position": sessions_service.position_to_out(db, session, ev["position"], ctx),
    }


@router.post("/{session_id}/step")
def step(session_id: str, body: StepRequest, db: DbSession = Depends(get_db)):
    session = _get_session_or_404(db, session_id)
    display_tf = sessions_service.validate_tf(body.display_tf or body.tf)
    result = sessions_service.step_forward(db, session, body.tf, body.n)
    cfg = sessions_service.get_or_create_symbol_config(db, session.symbol)
    cursor_ts = pd.Timestamp(session.cursor_time)
    df = resample.bars_since(
        session.symbol, display_tf, result["previous_cursor"], cursor_ts, tz=cfg.timezone,
        max_bars=sessions_service.MAX_STEP_CANDLES,
    )
    state = _state(db, session)
    ctx = sessions_service.cursor_context(db, session)
    return {
        **state,
        "display_tf": display_tf,
        "candles": sessions_service.df_to_candles(df),
        "events": [_event_out(db, session, e, ctx) for e in result["events"]],
        "end_of_data": result["end_of_data"],
    }


@router.post("/{session_id}/step_back")
def step_back(session_id: str, body: StepRequest, db: DbSession = Depends(get_db)):
    session = _get_session_or_404(db, session_id)
    sessions_service.step_back(db, session, body.tf, body.n)
    return _state(db, session)


@router.post("/{session_id}/jump")
def jump(session_id: str, body: JumpRequest, db: DbSession = Depends(get_db)):
    session = _get_session_or_404(db, session_id)
    sessions_service.jump(db, session, body.timestamp, body.force)
    return _state(db, session)


@router.post("/{session_id}/orders")
def place_order(session_id: str, body: OrderRequest, db: DbSession = Depends(get_db)):
    session = _get_session_or_404(db, session_id)
    row = sessions_service.place_order(db, session, body.side, body.lots, body.sl, body.tp, body.order_type, body.price)
    if body.order_type == "market":
        return sessions_service.position_to_out(db, session, row)
    return sessions_service.order_to_out(row)


@router.get("/{session_id}/orders")
def list_orders(session_id: str, db: DbSession = Depends(get_db)):
    session = _get_session_or_404(db, session_id)
    return [sessions_service.order_to_out(o) for o in sessions_service.get_pending_orders(db, session.id)]


@router.put("/{session_id}/orders/{order_id}")
def update_order(session_id: str, order_id: str, body: OrderUpdate, db: DbSession = Depends(get_db)):
    session = _get_session_or_404(db, session_id)
    row = sessions_service.modify_order(db, session, order_id, body.price, body.sl, body.tp, body.clear_sl, body.clear_tp)
    return sessions_service.order_to_out(row)


@router.delete("/{session_id}/orders/{order_id}")
def cancel_order(session_id: str, order_id: str, db: DbSession = Depends(get_db)):
    session = _get_session_or_404(db, session_id)
    row = sessions_service.cancel_order(db, session, order_id)
    return sessions_service.order_to_out(row)


@router.get("/{session_id}/positions")
def list_positions(session_id: str, db: DbSession = Depends(get_db)):
    session = _get_session_or_404(db, session_id)
    rows = sessions_service.get_open_positions(db, session.id)
    ctx = sessions_service.cursor_context(db, session)
    return [sessions_service.position_to_out(db, session, r, ctx) for r in rows]


@router.put("/{session_id}/positions/{position_id}")
def update_position(session_id: str, position_id: str, body: PositionUpdate, db: DbSession = Depends(get_db)):
    session = _get_session_or_404(db, session_id)
    row = sessions_service.modify_position(db, session, position_id, body.sl, body.tp, body.clear_sl, body.clear_tp)
    return sessions_service.position_to_out(db, session, row)


@router.post("/{session_id}/positions/{position_id}/close")
def close_position(session_id: str, position_id: str, db: DbSession = Depends(get_db)):
    session = _get_session_or_404(db, session_id)
    trade = sessions_service.close_position(db, session, position_id)
    return _trade_to_dict(trade)


@router.post("/{session_id}/positions/close_all")
def close_all(session_id: str, db: DbSession = Depends(get_db)):
    session = _get_session_or_404(db, session_id)
    trades = sessions_service.close_all_positions(db, session)
    return [_trade_to_dict(t) for t in trades]


def _session_trades(db: DbSession, session: ReplaySession) -> list[Trade]:
    return list(
        db.execute(select(Trade).where(Trade.session_id == session.id).order_by(Trade.close_time)).scalars().all()
    )


@router.get("/{session_id}/trades")
def list_trades(session_id: str, db: DbSession = Depends(get_db)):
    session = _get_session_or_404(db, session_id)
    return [_trade_to_dict(r) for r in _session_trades(db, session)]


@router.get("/{session_id}/stats")
def get_stats(session_id: str, db: DbSession = Depends(get_db)):
    session = _get_session_or_404(db, session_id)
    stats = compute_stats(_session_trades(db, session), session.starting_balance)
    return dict(stats.__dict__)


@router.get("/{session_id}/trades/export.csv")
def export_trades_csv(session_id: str, db: DbSession = Depends(get_db)):
    session = _get_session_or_404(db, session_id)
    rows = _session_trades(db, session)

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["id", "symbol", "side", "lots", "open_price", "close_price", "open_time", "close_time", "sl", "tp", "pnl", "close_reason"])
    for r in rows:
        writer.writerow([r.id, r.symbol, r.side, r.lots, r.open_price, r.close_price, r.open_time, r.close_time, r.sl, r.tp, r.pnl, r.close_reason])
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=trades_{session_id}.csv"},
    )


def _trade_to_dict(t) -> dict:
    return {
        "id": getattr(t, "id", None),
        "position_id": t.position_id,
        "symbol": getattr(t, "symbol", None),
        "side": t.side,
        "lots": t.lots,
        "open_price": t.open_price,
        "close_price": t.close_price,
        "open_time": t.open_time.isoformat() if hasattr(t.open_time, "isoformat") else t.open_time,
        "close_time": t.close_time.isoformat() if hasattr(t.close_time, "isoformat") else t.close_time,
        "sl": t.sl,
        "tp": t.tp,
        "pnl": t.pnl,
        "close_reason": t.close_reason,
    }

from __future__ import annotations

from datetime import datetime

import pandas as pd
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.data import parquet_store, resample
from app.db.models import Position as PositionRow
from app.db.models import ReplaySession
from app.db.models import SymbolConfig
from app.db.models import Trade as TradeRow
from app.engine import engine as trading_engine
from app.engine import pricing
from app.engine.models import Bar, EnginePosition


DEFAULT_POINT_SIZE = 0.01
DEFAULT_CONTRACT_SIZE = 100.0
DEFAULT_SPREAD_POINTS = 20.0


def get_or_create_symbol_config(db: DbSession, symbol: str) -> SymbolConfig:
    symbol = symbol.upper()
    cfg = db.get(SymbolConfig, symbol)
    if cfg is None:
        cfg = SymbolConfig(
            name=symbol,
            point_size=DEFAULT_POINT_SIZE,
            contract_size=DEFAULT_CONTRACT_SIZE,
            default_spread_points=DEFAULT_SPREAD_POINTS,
            timezone="UTC",
        )
        db.add(cfg)
        db.commit()
        db.refresh(cfg)
    return cfg


def df_to_candles(df: pd.DataFrame) -> list[dict]:
    out = []
    for ts, row in df.iterrows():
        out.append(
            {
                "timestamp": int(pd.Timestamp(ts).timestamp() * 1000),
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
                "volume": float(row.get("volume") or 0.0),
            }
        )
    return out


def row_to_bar(ts, row) -> Bar:
    spread = row.get("spread")
    return Bar(
        timestamp=pd.Timestamp(ts).to_pydatetime(),
        open=float(row["open"]),
        high=float(row["high"]),
        low=float(row["low"]),
        close=float(row["close"]),
        spread=float(spread) if spread is not None and not pd.isna(spread) else None,
    )


def _row_to_engine_position(row: PositionRow) -> EnginePosition:
    return EnginePosition(
        id=row.id,
        side=row.side,
        lots=row.lots,
        open_price=row.open_price,
        open_time=row.open_time,
        contract_size=row.contract_size,
        point_size=row.point_size,
        sl=row.sl,
        tp=row.tp,
    )


def get_open_positions(db: DbSession, session_id: str) -> list[PositionRow]:
    stmt = select(PositionRow).where(PositionRow.session_id == session_id, PositionRow.status == "open")
    return list(db.execute(stmt).scalars().all())


def create_session(db: DbSession, symbol: str, start_time: datetime, starting_balance: float, name: str) -> ReplaySession:
    symbol = symbol.upper()
    m1 = parquet_store.load_m1(symbol)
    if m1.empty:
        raise HTTPException(400, f"No data imported for symbol {symbol}")
    start_ts = pd.Timestamp(start_time)
    candidates = m1[m1.index >= start_ts]
    if candidates.empty:
        raise HTTPException(400, "start_time is after the last available bar for this symbol")
    cursor_ts = candidates.index[0]

    get_or_create_symbol_config(db, symbol)

    session = ReplaySession(
        name=name,
        symbol=symbol,
        start_time=cursor_ts.to_pydatetime(),
        cursor_time=cursor_ts.to_pydatetime(),
        starting_balance=starting_balance,
        balance=starting_balance,
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


def session_equity(db: DbSession, session: ReplaySession) -> tuple[float, list[PositionRow]]:
    open_rows = get_open_positions(db, session.id)
    if not open_rows:
        return session.balance, []
    m1 = parquet_store.load_m1(session.symbol)
    cursor_ts = pd.Timestamp(session.cursor_time)
    upto = m1[m1.index <= cursor_ts]
    if upto.empty:
        return session.balance, open_rows
    last_row = upto.iloc[-1]
    cfg = get_or_create_symbol_config(db, session.symbol)
    spread_points = last_row["spread"] if pd.notna(last_row.get("spread")) else cfg.default_spread_points
    floating_total = 0.0
    for row in open_rows:
        pos = _row_to_engine_position(row)
        floating_total += trading_engine.floating_pnl(pos, float(last_row["close"]), float(spread_points))
    return session.balance + floating_total, open_rows


def step_forward(db: DbSession, session: ReplaySession, tf: str, n: int) -> dict:
    if n <= 0:
        raise HTTPException(400, "n must be positive")
    cfg = get_or_create_symbol_config(db, session.symbol)
    m1 = parquet_store.load_m1(session.symbol)
    if m1.empty:
        raise HTTPException(400, "No data available")

    cursor_ts = pd.Timestamp(session.cursor_time)
    # Anchor bucket math on the bucket the *next* bar would fall into, not the
    # bucket containing the cursor's own bar: for M1, bucket size == bar size,
    # so the cursor's own bucket is always already "complete" the instant the
    # cursor lands on it, and using it as the anchor would never admit any
    # future bar (n buckets forward would resolve to a bound equal to the very
    # next bar's timestamp, then get excluded by the strict "<" below).
    next_bucket = resample.floor_to_bucket(cursor_ts + pd.Timedelta(minutes=1), tf, cfg.timezone)
    target_bucket = resample.advance_bucket(next_bucket, tf, n - 1, cfg.timezone)
    cutoff = resample.advance_bucket(target_bucket, tf, 1, cfg.timezone)

    future = m1[m1.index > cursor_ts]
    future = future[future.index < cutoff]

    open_rows = {row.id: row for row in get_open_positions(db, session.id)}
    open_positions = {pid: _row_to_engine_position(row) for pid, row in open_rows.items()}

    all_events = []
    new_cursor = cursor_ts
    for ts, row in future.iterrows():
        bar = row_to_bar(ts, row)
        closed = trading_engine.process_m1_bar(open_positions, bar, cfg.default_spread_points)
        for trade in closed:
            _persist_closed_trade(db, session, open_rows[trade.position_id], trade)
            del open_rows[trade.position_id]
        all_events.extend(closed)
        new_cursor = ts

    end_of_data = future.empty and m1.index[-1] <= cursor_ts
    session.cursor_time = new_cursor.to_pydatetime()
    db.commit()
    db.refresh(session)

    return {"events": all_events, "end_of_data": end_of_data}


def step_back(db: DbSession, session: ReplaySession, tf: str, n: int) -> None:
    if n <= 0:
        raise HTTPException(400, "n must be positive")
    open_rows = get_open_positions(db, session.id)
    if open_rows:
        raise HTTPException(409, "Cannot step back while positions are open")

    cfg = get_or_create_symbol_config(db, session.symbol)
    m1 = parquet_store.load_m1(session.symbol)
    if m1.empty:
        raise HTTPException(400, "No data available")

    cursor_ts = pd.Timestamp(session.cursor_time)
    start_bucket = resample.floor_to_bucket(cursor_ts, tf, cfg.timezone)
    target_bucket_start = resample.advance_bucket(start_bucket, tf, -n, cfg.timezone)

    session_start_ts = pd.Timestamp(session.start_time)
    floor_limit = max(target_bucket_start, session_start_ts, m1.index[0])
    bucket_end_exclusive = resample.advance_bucket(target_bucket_start, tf, 1, cfg.timezone)

    candidates = m1[(m1.index < bucket_end_exclusive) & (m1.index >= floor_limit) & (m1.index <= cursor_ts)]
    new_cursor = candidates.index[-1] if not candidates.empty else max(session_start_ts, m1.index[0])

    session.cursor_time = pd.Timestamp(new_cursor).to_pydatetime()
    db.commit()
    db.refresh(session)


def jump(db: DbSession, session: ReplaySession, timestamp: datetime, force: bool) -> None:
    open_rows = get_open_positions(db, session.id)
    if open_rows and not force:
        raise HTTPException(409, "Open positions exist; confirm to jump anyway (fills will not be simulated across the skipped range)")

    m1 = parquet_store.load_m1(session.symbol)
    if m1.empty:
        raise HTTPException(400, "No data available")
    ts = pd.Timestamp(timestamp)
    candidates = m1[m1.index <= ts]
    if candidates.empty:
        candidates = m1
    new_cursor = candidates.index[-1]
    session.cursor_time = new_cursor.to_pydatetime()
    db.commit()
    db.refresh(session)


def _persist_closed_trade(db: DbSession, session: ReplaySession, position_row: PositionRow, trade) -> TradeRow:
    trade_row = TradeRow(
        session_id=session.id,
        position_id=position_row.id,
        symbol=position_row.symbol,
        side=trade.side,
        lots=trade.lots,
        open_price=trade.open_price,
        close_price=trade.close_price,
        open_time=trade.open_time,
        close_time=trade.close_time,
        sl=trade.sl,
        tp=trade.tp,
        pnl=trade.pnl,
        close_reason=trade.close_reason,
        contract_size=position_row.contract_size,
    )
    db.add(trade_row)
    position_row.status = "closed"
    session.balance += trade.pnl
    db.commit()
    db.refresh(trade_row)
    return trade_row


def place_market_order(db: DbSession, session: ReplaySession, side: str, lots: float, sl: float | None, tp: float | None) -> PositionRow:
    if lots <= 0:
        raise HTTPException(400, "lots must be positive")
    cfg = get_or_create_symbol_config(db, session.symbol)
    m1 = parquet_store.load_m1(session.symbol)
    cursor_ts = pd.Timestamp(session.cursor_time)
    upto = m1[m1.index <= cursor_ts]
    if upto.empty:
        raise HTTPException(400, "No bar data at cursor to fill order")
    last_ts = upto.index[-1]
    bar = row_to_bar(last_ts, upto.iloc[-1])

    engine_pos = trading_engine.open_market_position(
        bar, side, lots, cfg.contract_size, cfg.point_size, cfg.default_spread_points, sl=sl, tp=tp
    )
    row = PositionRow(
        id=engine_pos.id,
        session_id=session.id,
        symbol=session.symbol,
        side=side,
        lots=lots,
        open_price=engine_pos.open_price,
        open_time=engine_pos.open_time,
        sl=sl,
        tp=tp,
        contract_size=cfg.contract_size,
        point_size=cfg.point_size,
        status="open",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def modify_position(db: DbSession, session: ReplaySession, position_id: str, sl: float | None, tp: float | None,
                     clear_sl: bool, clear_tp: bool) -> PositionRow:
    row = db.get(PositionRow, position_id)
    if row is None or row.session_id != session.id or row.status != "open":
        raise HTTPException(404, "Open position not found")
    if clear_sl:
        row.sl = None
    elif sl is not None:
        row.sl = sl
    if clear_tp:
        row.tp = None
    elif tp is not None:
        row.tp = tp
    db.commit()
    db.refresh(row)
    return row


def close_position(db: DbSession, session: ReplaySession, position_id: str) -> TradeRow:
    row = db.get(PositionRow, position_id)
    if row is None or row.session_id != session.id or row.status != "open":
        raise HTTPException(404, "Open position not found")
    cfg = get_or_create_symbol_config(db, session.symbol)
    m1 = parquet_store.load_m1(session.symbol)
    cursor_ts = pd.Timestamp(session.cursor_time)
    upto = m1[m1.index <= cursor_ts]
    if upto.empty:
        raise HTTPException(400, "No bar data at cursor to close position")
    last_ts = upto.index[-1]
    bar = row_to_bar(last_ts, upto.iloc[-1])
    engine_pos = _row_to_engine_position(row)
    trade = trading_engine.close_position_manually(engine_pos, bar, cfg.default_spread_points)
    return _persist_closed_trade(db, session, row, trade)


def close_all_positions(db: DbSession, session: ReplaySession) -> list[TradeRow]:
    rows = get_open_positions(db, session.id)
    return [close_position(db, session, row.id) for row in rows]


def position_to_out(db: DbSession, session: ReplaySession, row: PositionRow) -> dict:
    cfg = get_or_create_symbol_config(db, session.symbol)
    m1 = parquet_store.load_m1(session.symbol)
    cursor_ts = pd.Timestamp(session.cursor_time)
    upto = m1[m1.index <= cursor_ts]
    current_price = None
    floating = None
    if not upto.empty:
        last_row = upto.iloc[-1]
        current_price = float(last_row["close"])
        spread_points = last_row["spread"] if pd.notna(last_row.get("spread")) else cfg.default_spread_points
        engine_pos = _row_to_engine_position(row)
        floating = trading_engine.floating_pnl(engine_pos, current_price, float(spread_points))
    return {
        "id": row.id,
        "symbol": row.symbol,
        "side": row.side,
        "lots": row.lots,
        "open_price": row.open_price,
        "open_time": row.open_time,
        "sl": row.sl,
        "tp": row.tp,
        "current_price": current_price,
        "floating_pnl": floating,
    }

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional

import numpy as np
import pandas as pd
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.config import TIMEFRAMES
from app.data import parquet_store, resample
from app.db.models import PendingOrder as OrderRow
from app.db.models import Position as PositionRow
from app.db.models import ReplaySession
from app.db.models import SymbolConfig
from app.db.models import Trade as TradeRow
from app.engine import engine as trading_engine
from app.engine import pricing
from app.engine.models import Bar, EnginePendingOrder, EnginePosition


DEFAULT_POINT_SIZE = 0.01
DEFAULT_CONTRACT_SIZE = 100.0
DEFAULT_SPREAD_POINTS = 20.0

# Sensible broker-like defaults for well-known instruments, so a freshly
# downloaded EURUSD doesn't get gold's 0.01 point / 100 oz contract (which
# made spreads and P/L wildly wrong). (point_size, contract_size, spread_points)
SYMBOL_PRESETS: dict[str, tuple[float, float, float]] = {
    "XAUUSD": (0.01, 100.0, 20.0),
    "XAGUSD": (0.001, 5000.0, 30.0),
    "EURUSD": (0.00001, 100000.0, 10.0),
    "GBPUSD": (0.00001, 100000.0, 12.0),
    "AUDUSD": (0.00001, 100000.0, 12.0),
    "NZDUSD": (0.00001, 100000.0, 15.0),
    "USDCAD": (0.00001, 100000.0, 15.0),
    "USDCHF": (0.00001, 100000.0, 15.0),
    "USDJPY": (0.001, 100000.0, 12.0),
    "BTCUSD": (0.01, 1.0, 3000.0),
    "ETHUSD": (0.01, 1.0, 200.0),
}

MAX_STEP_CANDLES = 2000


def validate_tf(tf: str) -> str:
    if tf not in TIMEFRAMES:
        raise HTTPException(400, f"Unknown timeframe {tf!r}; expected one of {', '.join(TIMEFRAMES)}")
    return tf


def get_or_create_symbol_config(db: DbSession, symbol: str) -> SymbolConfig:
    symbol = symbol.upper()
    cfg = db.get(SymbolConfig, symbol)
    if cfg is None:
        point, contract, spread = SYMBOL_PRESETS.get(
            symbol, (DEFAULT_POINT_SIZE, DEFAULT_CONTRACT_SIZE, DEFAULT_SPREAD_POINTS)
        )
        cfg = SymbolConfig(
            name=symbol,
            point_size=point,
            contract_size=contract,
            default_spread_points=spread,
            timezone="UTC",
        )
        db.add(cfg)
        db.commit()
        db.refresh(cfg)
    return cfg


def df_to_candles(df: pd.DataFrame) -> list[dict]:
    if df is None or df.empty:
        return []
    idx = pd.DatetimeIndex(df.index)
    ms = ((idx - pd.Timestamp(0)) // pd.Timedelta(milliseconds=1)).astype("int64")
    vol = df["volume"].to_numpy(dtype="float64", na_value=0.0) if "volume" in df else np.zeros(len(df))
    vol = np.nan_to_num(vol)
    return [
        {"timestamp": int(t), "open": float(o), "high": float(h), "low": float(l), "close": float(c), "volume": float(v)}
        for t, o, h, l, c, v in zip(
            ms,
            df["open"].to_numpy(dtype="float64"),
            df["high"].to_numpy(dtype="float64"),
            df["low"].to_numpy(dtype="float64"),
            df["close"].to_numpy(dtype="float64"),
            vol,
        )
    ]


def _bar(ts, o, h, l, c, spread) -> Bar:
    return Bar(
        timestamp=pd.Timestamp(ts).to_pydatetime(),
        open=float(o),
        high=float(h),
        low=float(l),
        close=float(c),
        spread=None if spread is None or pd.isna(spread) else float(spread),
    )


def row_to_bar(ts, row) -> Bar:
    return _bar(ts, row["open"], row["high"], row["low"], row["close"], row.get("spread"))


# ---------------------------------------------------------------------------
# Cursor context: everything a request needs about "now" in the replay,
# computed once per request instead of reloading / re-slicing M1 repeatedly.
# ---------------------------------------------------------------------------


@dataclass
class CursorContext:
    cfg: SymbolConfig
    m1: pd.DataFrame
    bar: Optional[Bar]  # the M1 bar at/before the cursor

    @property
    def spread_points(self) -> float:
        if self.bar is None:
            return self.cfg.default_spread_points
        return pricing.effective_spread_points(self.bar, self.cfg.default_spread_points)

    @property
    def bid(self) -> Optional[float]:
        return self.bar.close if self.bar else None

    @property
    def ask(self) -> Optional[float]:
        if self.bar is None:
            return None
        return pricing.ask_of(self.bar.close, self.spread_points, self.cfg.point_size)

    def quote(self) -> Optional[dict]:
        if self.bar is None:
            return None
        return {
            "time": self.bar.timestamp,
            "bid": self.bid,
            "ask": self.ask,
            "spread_points": self.spread_points,
        }


def cursor_context(db: DbSession, session: ReplaySession) -> CursorContext:
    cfg = get_or_create_symbol_config(db, session.symbol)
    m1 = parquet_store.load_m1(session.symbol)
    upto = parquet_store.upto(m1, pd.Timestamp(session.cursor_time))
    bar = row_to_bar(upto.index[-1], upto.iloc[-1]) if not upto.empty else None
    return CursorContext(cfg=cfg, m1=m1, bar=bar)


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


def _row_to_engine_order(row: OrderRow) -> EnginePendingOrder:
    return EnginePendingOrder(
        id=row.id,
        side=row.side,
        order_type=row.order_type,
        price=row.price,
        lots=row.lots,
        created_time=row.created_time,
        sl=row.sl,
        tp=row.tp,
    )


def get_open_positions(db: DbSession, session_id: str) -> list[PositionRow]:
    stmt = select(PositionRow).where(PositionRow.session_id == session_id, PositionRow.status == "open")
    return list(db.execute(stmt).scalars().all())


def get_pending_orders(db: DbSession, session_id: str) -> list[OrderRow]:
    stmt = select(OrderRow).where(OrderRow.session_id == session_id, OrderRow.status == "pending")
    return list(db.execute(stmt).scalars().all())


def create_session(db: DbSession, symbol: str, start_time: datetime, starting_balance: float, name: str) -> ReplaySession:
    symbol = symbol.upper()
    if starting_balance <= 0:
        raise HTTPException(400, "starting_balance must be positive")
    m1 = parquet_store.load_m1(symbol)
    if m1.empty:
        raise HTTPException(400, f"No data imported for symbol {symbol}")
    pos = m1.index.searchsorted(pd.Timestamp(start_time), side="left")
    if pos >= len(m1):
        raise HTTPException(400, "start_time is after the last available bar for this symbol")
    cursor_ts = m1.index[pos]

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


def session_equity(
    db: DbSession, session: ReplaySession, ctx: Optional[CursorContext] = None,
    open_rows: Optional[list[PositionRow]] = None,
) -> tuple[float, list[PositionRow]]:
    if open_rows is None:
        open_rows = get_open_positions(db, session.id)
    if not open_rows:
        return session.balance, []
    ctx = ctx or cursor_context(db, session)
    if ctx.bar is None:
        return session.balance, open_rows
    floating_total = 0.0
    for row in open_rows:
        pos = _row_to_engine_position(row)
        floating_total += trading_engine.floating_pnl(pos, ctx.bar.close, ctx.spread_points)
    return session.balance + floating_total, open_rows


def step_forward(db: DbSession, session: ReplaySession, tf: str, n: int) -> dict:
    validate_tf(tf)
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
    # Skip over data gaps (weekends, daily breaks, missing minutes): without
    # this, a step whose next bucket has no bars returned nothing and the
    # cursor never moved again, silently stalling playback at every gap.
    next_pos = m1.index.searchsorted(cursor_ts, side="right")
    if next_pos < len(m1):
        next_bucket = max(next_bucket, resample.floor_to_bucket(m1.index[next_pos], tf, cfg.timezone))
    target_bucket = resample.advance_bucket(next_bucket, tf, n - 1, cfg.timezone)
    cutoff = resample.advance_bucket(target_bucket, tf, 1, cfg.timezone)

    future = parquet_store.between(m1, cursor_ts, cutoff)

    open_rows = {row.id: row for row in get_open_positions(db, session.id)}
    open_positions = {pid: _row_to_engine_position(row) for pid, row in open_rows.items()}
    order_rows = {row.id: row for row in get_pending_orders(db, session.id)}
    pending = {oid: _row_to_engine_order(row) for oid, row in order_rows.items()}

    events: list[dict] = []
    new_cursor = cursor_ts
    if not future.empty and (open_positions or pending):
        spreads = future["spread"].to_numpy(dtype="float64")
        for ts, o, h, l, c, sp in zip(
            future.index, future["open"].to_numpy(), future["high"].to_numpy(),
            future["low"].to_numpy(), future["close"].to_numpy(), spreads,
        ):
            bar = _bar(ts, o, h, l, c, sp)
            # 1) existing positions: SL/TP
            if open_positions:
                for trade in trading_engine.process_m1_bar(open_positions, bar, cfg.default_spread_points):
                    row = _persist_closed_trade(db, session, open_rows.pop(trade.position_id), trade)
                    events.append({"type": "closed", "trade": row})
            # 2) pending orders: triggers (new positions are SL/TP-checked from the next bar)
            if pending:
                spread_points = pricing.effective_spread_points(bar, cfg.default_spread_points)
                for oid in list(pending.keys()):
                    order = pending[oid]
                    fill = trading_engine.check_pending_trigger(order, bar, spread_points, cfg.point_size)
                    if fill is None:
                        continue
                    pos = trading_engine.fill_pending_order(order, fill, bar.timestamp, cfg.contract_size, cfg.point_size)
                    pos_row = _persist_position(db, session, pos)
                    order_row = order_rows.pop(oid)
                    order_row.status = "filled"
                    order_row.position_id = pos_row.id
                    del pending[oid]
                    open_rows[pos_row.id] = pos_row
                    open_positions[pos_row.id] = pos
                    events.append({"type": "filled", "order": order_row, "position": pos_row})
        db.commit()
    if not future.empty:
        new_cursor = future.index[-1]

    end_of_data = future.empty or new_cursor >= m1.index[-1]
    session.cursor_time = new_cursor.to_pydatetime()
    db.commit()
    db.refresh(session)

    return {"events": events, "end_of_data": bool(end_of_data), "previous_cursor": cursor_ts}


def step_back(db: DbSession, session: ReplaySession, tf: str, n: int) -> None:
    validate_tf(tf)
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
    upper = min(bucket_end_exclusive, cursor_ts + pd.Timedelta(microseconds=1))

    lo = m1.index.searchsorted(floor_limit, side="left")
    hi = m1.index.searchsorted(upper, side="left")
    if hi > lo:
        new_cursor = m1.index[hi - 1]
    else:
        new_cursor = max(session_start_ts, m1.index[0])

    session.cursor_time = pd.Timestamp(new_cursor).to_pydatetime()
    db.commit()
    db.refresh(session)


def jump(db: DbSession, session: ReplaySession, timestamp: datetime, force: bool) -> None:
    open_rows = get_open_positions(db, session.id)
    orders = get_pending_orders(db, session.id)
    if (open_rows or orders) and not force:
        raise HTTPException(
            409,
            "Open positions or pending orders exist; confirm to jump anyway "
            "(fills will not be simulated across the skipped range)",
        )

    m1 = parquet_store.load_m1(session.symbol)
    if m1.empty:
        raise HTTPException(400, "No data available")
    pos = m1.index.searchsorted(pd.Timestamp(timestamp), side="right")
    new_cursor = m1.index[max(pos - 1, 0)]
    session.cursor_time = new_cursor.to_pydatetime()
    # Jumping before the original start re-anchors the session start so that
    # step-back limits stay consistent with the new cursor.
    if new_cursor.to_pydatetime() < session.start_time:
        session.start_time = new_cursor.to_pydatetime()
    db.commit()
    db.refresh(session)


def _persist_position(db: DbSession, session: ReplaySession, pos: EnginePosition) -> PositionRow:
    row = PositionRow(
        id=pos.id,
        session_id=session.id,
        symbol=session.symbol,
        side=pos.side,
        lots=pos.lots,
        open_price=pos.open_price,
        open_time=pos.open_time,
        sl=pos.sl,
        tp=pos.tp,
        contract_size=pos.contract_size,
        point_size=pos.point_size,
        status="open",
    )
    db.add(row)
    db.flush()
    return row


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


def _invalid(e: Exception) -> HTTPException:
    return HTTPException(400, str(e))


def place_order(
    db: DbSession, session: ReplaySession, side: str, lots: float, sl: float | None, tp: float | None,
    order_type: str = "market", price: float | None = None,
):
    """Market orders return a PositionRow; limit/stop orders return an OrderRow."""
    if lots <= 0:
        raise HTTPException(400, "lots must be positive")
    ctx = cursor_context(db, session)
    if ctx.bar is None:
        raise HTTPException(400, "No bar data at cursor to fill order")

    if order_type == "market":
        engine_pos = trading_engine.open_market_position(
            ctx.bar, side, lots, ctx.cfg.contract_size, ctx.cfg.point_size, ctx.cfg.default_spread_points, sl=sl, tp=tp
        )
        reference = ctx.bid if side == "buy" else ctx.ask
        try:
            trading_engine.validate_stops(side, reference, sl, tp)
        except trading_engine.InvalidStopsError as e:
            raise _invalid(e) from e
        row = _persist_position(db, session, engine_pos)
        db.commit()
        db.refresh(row)
        return row

    if order_type not in ("limit", "stop"):
        raise HTTPException(400, f"Unknown order type {order_type!r}")
    if price is None:
        raise HTTPException(400, f"A {order_type} order needs a price")
    try:
        trading_engine.validate_pending_price(side, order_type, price, ctx.bid, ctx.ask)
        trading_engine.validate_stops(side, price, sl, tp)
    except trading_engine.InvalidStopsError as e:
        raise _invalid(e) from e
    row = OrderRow(
        session_id=session.id,
        symbol=session.symbol,
        side=side,
        order_type=order_type,
        price=price,
        lots=lots,
        sl=sl,
        tp=tp,
        created_time=ctx.bar.timestamp,
        status="pending",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


# Backwards-compatible name used by older callers/tests.
def place_market_order(db: DbSession, session: ReplaySession, side: str, lots: float, sl: float | None, tp: float | None) -> PositionRow:
    return place_order(db, session, side, lots, sl, tp, "market")


def _apply_patch(current: float | None, new: float | None, clear: bool) -> float | None:
    if clear:
        return None
    return new if new is not None else current


def modify_position(db: DbSession, session: ReplaySession, position_id: str, sl: float | None, tp: float | None,
                     clear_sl: bool, clear_tp: bool) -> PositionRow:
    row = db.get(PositionRow, position_id)
    if row is None or row.session_id != session.id or row.status != "open":
        raise HTTPException(404, "Open position not found")
    new_sl = _apply_patch(row.sl, sl, clear_sl)
    new_tp = _apply_patch(row.tp, tp, clear_tp)
    ctx = cursor_context(db, session)
    if ctx.bar is not None:
        reference = ctx.bid if row.side == "buy" else ctx.ask
        try:
            # Only validate the values that are actually changing, so an
            # already-set level never blocks editing the other one.
            trading_engine.validate_stops(
                row.side, reference,
                new_sl if new_sl != row.sl else None,
                new_tp if new_tp != row.tp else None,
            )
        except trading_engine.InvalidStopsError as e:
            raise _invalid(e) from e
    row.sl, row.tp = new_sl, new_tp
    db.commit()
    db.refresh(row)
    return row


def modify_order(db: DbSession, session: ReplaySession, order_id: str, price: float | None, sl: float | None,
                 tp: float | None, clear_sl: bool, clear_tp: bool) -> OrderRow:
    row = db.get(OrderRow, order_id)
    if row is None or row.session_id != session.id or row.status != "pending":
        raise HTTPException(404, "Pending order not found")
    new_price = price if price is not None else row.price
    new_sl = _apply_patch(row.sl, sl, clear_sl)
    new_tp = _apply_patch(row.tp, tp, clear_tp)
    ctx = cursor_context(db, session)
    try:
        if ctx.bar is not None and new_price != row.price:
            trading_engine.validate_pending_price(row.side, row.order_type, new_price, ctx.bid, ctx.ask)
        trading_engine.validate_stops(row.side, new_price, new_sl, new_tp)
    except trading_engine.InvalidStopsError as e:
        raise _invalid(e) from e
    row.price, row.sl, row.tp = new_price, new_sl, new_tp
    db.commit()
    db.refresh(row)
    return row


def cancel_order(db: DbSession, session: ReplaySession, order_id: str) -> OrderRow:
    row = db.get(OrderRow, order_id)
    if row is None or row.session_id != session.id or row.status != "pending":
        raise HTTPException(404, "Pending order not found")
    row.status = "cancelled"
    db.commit()
    db.refresh(row)
    return row


def close_position(db: DbSession, session: ReplaySession, position_id: str, ctx: Optional[CursorContext] = None) -> TradeRow:
    row = db.get(PositionRow, position_id)
    if row is None or row.session_id != session.id or row.status != "open":
        raise HTTPException(404, "Open position not found")
    ctx = ctx or cursor_context(db, session)
    if ctx.bar is None:
        raise HTTPException(400, "No bar data at cursor to close position")
    engine_pos = _row_to_engine_position(row)
    trade = trading_engine.close_position_manually(engine_pos, ctx.bar, ctx.cfg.default_spread_points)
    return _persist_closed_trade(db, session, row, trade)


def close_all_positions(db: DbSession, session: ReplaySession) -> list[TradeRow]:
    rows = get_open_positions(db, session.id)
    ctx = cursor_context(db, session)
    return [close_position(db, session, row.id, ctx) for row in rows]


def position_to_out(db: DbSession, session: ReplaySession, row: PositionRow, ctx: Optional[CursorContext] = None) -> dict:
    ctx = ctx or cursor_context(db, session)
    current_price = None
    floating = None
    if ctx.bar is not None:
        engine_pos = _row_to_engine_position(row)
        current_price = trading_engine.pricing.exit_price_for_close(
            row.side, ctx.bar.close, ctx.spread_points, row.point_size
        )
        floating = trading_engine.floating_pnl(engine_pos, ctx.bar.close, ctx.spread_points)
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


def order_to_out(row: OrderRow) -> dict:
    return {
        "id": row.id,
        "symbol": row.symbol,
        "side": row.side,
        "order_type": row.order_type,
        "price": row.price,
        "lots": row.lots,
        "sl": row.sl,
        "tp": row.tp,
        "created_time": row.created_time,
        "status": row.status,
        "position_id": row.position_id,
    }

"""Pure-python trading simulation engine. No FastAPI / web imports here so it
can be unit tested standalone (see tests/test_engine_*.py).

Fill rules implemented:
  - Market orders fill at the close of the "current" bar, spread applied
    (buy at ask, sell at bid).
  - SL/TP are checked per M1 bar against that bar's high/low, using the
    correct bid/ask side for the position's direction.
  - If both SL and TP are touched within the same M1 bar, SL is assumed hit
    first.
  - If the bar opens beyond SL or TP (a gap), the position fills at the open
    price (on the relevant bid/ask side) instead of at the SL/TP level.
  - Pending orders trigger on the side they would execute on: buy orders on
    the ask (bar + spread), sell orders on the bid. Limit orders fill at their
    price, or at the open if the bar gaps through it (price improvement);
    stop orders fill at their price, or at the open if it gaps through
    (slippage). A position opened by a pending order is checked for SL/TP
    from the next M1 bar onward.
"""
from __future__ import annotations

import uuid
from typing import Optional

from app.engine import pricing
from app.engine.models import Bar, ClosedTrade, EnginePendingOrder, EnginePosition, Side


def open_market_position(
    bar: Bar,
    side: Side,
    lots: float,
    contract_size: float,
    point_size: float,
    default_spread_points: float,
    sl: Optional[float] = None,
    tp: Optional[float] = None,
    position_id: Optional[str] = None,
) -> EnginePosition:
    spread_points = pricing.effective_spread_points(bar, default_spread_points)
    fill_price = pricing.entry_price(side, bar.close, spread_points, point_size)
    return EnginePosition(
        id=position_id or uuid.uuid4().hex,
        side=side,
        lots=lots,
        open_price=fill_price,
        open_time=bar.timestamp,
        contract_size=contract_size,
        point_size=point_size,
        sl=sl,
        tp=tp,
    )


def _check_sl_tp_hit(position: EnginePosition, bar: Bar, spread_points: float) -> Optional[tuple[float, str]]:
    """Return (fill_price, reason) if the position's SL or TP is triggered by
    this bar, else None. reason is 'sl' or 'tp'."""
    sl, tp = position.sl, position.tp
    if sl is None and tp is None:
        return None

    if position.side == "buy":
        exit_open, exit_high, exit_low = bar.open, bar.high, bar.low
        gap_sl = sl is not None and exit_open <= sl
        gap_tp = tp is not None and exit_open >= tp
        hit_sl = sl is not None and exit_low <= sl
        hit_tp = tp is not None and exit_high >= tp
    else:
        spread_val = pricing.spread_price(spread_points, position.point_size)
        exit_open = bar.open + spread_val
        exit_high = bar.high + spread_val
        exit_low = bar.low + spread_val
        gap_sl = sl is not None and exit_open >= sl
        gap_tp = tp is not None and exit_open <= tp
        hit_sl = sl is not None and exit_high >= sl
        hit_tp = tp is not None and exit_low <= tp

    if gap_sl:
        return exit_open, "sl"
    if gap_tp:
        return exit_open, "tp"
    if hit_sl and hit_tp:
        return sl, "sl"
    if hit_sl:
        return sl, "sl"
    if hit_tp:
        return tp, "tp"
    return None


def process_m1_bar(
    positions: dict[str, EnginePosition],
    bar: Bar,
    default_spread_points: float,
) -> list[ClosedTrade]:
    """Check all open positions against a single M1 bar. Returns closed
    trades (SL/TP hits) and removes them from `positions`."""
    spread_points = pricing.effective_spread_points(bar, default_spread_points)
    closed: list[ClosedTrade] = []
    for pos_id in list(positions.keys()):
        position = positions[pos_id]
        result = _check_sl_tp_hit(position, bar, spread_points)
        if result is None:
            continue
        fill_price, reason = result
        trade = _close(position, fill_price, bar.timestamp, reason)
        closed.append(trade)
        del positions[pos_id]
    return closed


def close_position_manually(
    position: EnginePosition,
    bar: Bar,
    default_spread_points: float,
) -> ClosedTrade:
    spread_points = pricing.effective_spread_points(bar, default_spread_points)
    fill_price = pricing.exit_price_for_close(position.side, bar.close, spread_points, position.point_size)
    return _close(position, fill_price, bar.timestamp, "manual")


def _close(position: EnginePosition, fill_price: float, close_time, reason) -> ClosedTrade:
    realized_pnl = pricing.pnl(position.side, position.open_price, fill_price, position.lots, position.contract_size)
    return ClosedTrade(
        position_id=position.id,
        side=position.side,
        lots=position.lots,
        open_price=position.open_price,
        close_price=fill_price,
        open_time=position.open_time,
        close_time=close_time,
        sl=position.sl,
        tp=position.tp,
        pnl=realized_pnl,
        close_reason=reason,
    )


def floating_pnl(position: EnginePosition, current_bid: float, spread_points: float) -> float:
    exit_price = pricing.exit_price_for_close(position.side, current_bid, spread_points, position.point_size)
    return pricing.pnl(position.side, position.open_price, exit_price, position.lots, position.contract_size)


class InvalidStopsError(ValueError):
    pass


def validate_stops(side: Side, reference_price: float, sl: Optional[float], tp: Optional[float]) -> None:
    """Reject SL/TP on the wrong side of the price the position would be
    closed against (bid for longs, ask for shorts), like MT5's 'invalid
    stops'. Without this an inverted SL/TP closes the trade on the very next
    bar, which is never what the user meant."""
    if side == "buy":
        if sl is not None and sl >= reference_price:
            raise InvalidStopsError(f"Buy stop loss must be below {reference_price:g}")
        if tp is not None and tp <= reference_price:
            raise InvalidStopsError(f"Buy take profit must be above {reference_price:g}")
    else:
        if sl is not None and sl <= reference_price:
            raise InvalidStopsError(f"Sell stop loss must be above {reference_price:g}")
        if tp is not None and tp >= reference_price:
            raise InvalidStopsError(f"Sell take profit must be below {reference_price:g}")


def validate_pending_price(side: Side, order_type: str, price: float, bid: float, ask: float) -> None:
    """Limit orders must be better than market, stop orders worse."""
    market = ask if side == "buy" else bid
    if price <= 0:
        raise InvalidStopsError("Order price must be positive")
    if side == "buy":
        if order_type == "limit" and price >= market:
            raise InvalidStopsError(f"Buy limit must be below the ask ({market:g}); use a buy stop instead")
        if order_type == "stop" and price <= market:
            raise InvalidStopsError(f"Buy stop must be above the ask ({market:g}); use a buy limit instead")
    else:
        if order_type == "limit" and price <= market:
            raise InvalidStopsError(f"Sell limit must be above the bid ({market:g}); use a sell stop instead")
        if order_type == "stop" and price >= market:
            raise InvalidStopsError(f"Sell stop must be below the bid ({market:g}); use a sell limit instead")


def check_pending_trigger(order: EnginePendingOrder, bar: Bar, spread_points: float, point_size: float) -> Optional[float]:
    """Return the fill price if `order` triggers during `bar`, else None."""
    if bar.timestamp <= order.created_time:
        return None
    if order.side == "buy":
        spread_val = pricing.spread_price(spread_points, point_size)
        o, h, l = bar.open + spread_val, bar.high + spread_val, bar.low + spread_val
    else:
        o, h, l = bar.open, bar.high, bar.low
    p = order.price
    if order.side == "buy" and order.order_type == "limit":
        if o <= p:
            return o
        return p if l <= p else None
    if order.side == "buy" and order.order_type == "stop":
        if o >= p:
            return o
        return p if h >= p else None
    if order.side == "sell" and order.order_type == "limit":
        if o >= p:
            return o
        return p if h >= p else None
    # sell stop
    if o <= p:
        return o
    return p if l <= p else None


def fill_pending_order(
    order: EnginePendingOrder,
    fill_price: float,
    fill_time,
    contract_size: float,
    point_size: float,
) -> EnginePosition:
    return EnginePosition(
        id=uuid.uuid4().hex,
        side=order.side,
        lots=order.lots,
        open_price=fill_price,
        open_time=fill_time,
        contract_size=contract_size,
        point_size=point_size,
        sl=order.sl,
        tp=order.tp,
    )

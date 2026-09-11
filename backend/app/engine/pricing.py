"""Bid/ask price helpers.

Convention (matches MT5): bar OHLC values are BID prices. ask = bid + spread.
A long (buy) position enters at ask and exits (sells) at bid.
A short (sell) position enters at bid and exits (buys) at ask.
"""
from __future__ import annotations

from app.engine.models import Bar, Side


def spread_price(spread_points: float, point_size: float) -> float:
    return spread_points * point_size


def effective_spread_points(bar: Bar, default_spread_points: float) -> float:
    return bar.spread if bar.spread is not None else default_spread_points


def ask_of(bid_price: float, spread_points: float, point_size: float) -> float:
    return bid_price + spread_price(spread_points, point_size)


def entry_price(side: Side, bid_price: float, spread_points: float, point_size: float) -> float:
    """Price a market order fills at."""
    if side == "buy":
        return ask_of(bid_price, spread_points, point_size)
    return bid_price


def exit_price_for_close(side: Side, bid_price: float, spread_points: float, point_size: float) -> float:
    """Price a position of `side` closes at, given the current bid price."""
    if side == "buy":
        return bid_price
    return ask_of(bid_price, spread_points, point_size)


def pnl(side: Side, open_price: float, close_price: float, lots: float, contract_size: float) -> float:
    diff = (close_price - open_price) if side == "buy" else (open_price - close_price)
    return diff * lots * contract_size

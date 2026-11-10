from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal, Optional

Side = Literal["buy", "sell"]
CloseReason = Literal["manual", "sl", "tp"]
OrderType = Literal["limit", "stop"]


@dataclass
class Bar:
    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    spread: Optional[float] = None  # in points


@dataclass
class EnginePosition:
    id: str
    side: Side
    lots: float
    open_price: float
    open_time: datetime
    contract_size: float
    point_size: float
    sl: Optional[float] = None
    tp: Optional[float] = None


@dataclass
class EnginePendingOrder:
    id: str
    side: Side
    order_type: OrderType
    price: float
    lots: float
    created_time: datetime
    sl: Optional[float] = None
    tp: Optional[float] = None


@dataclass
class ClosedTrade:
    position_id: str
    side: Side
    lots: float
    open_price: float
    close_price: float
    open_time: datetime
    close_time: datetime
    sl: Optional[float]
    tp: Optional[float]
    pnl: float
    close_reason: CloseReason


@dataclass
class StepResult:
    closed_trades: list[ClosedTrade] = field(default_factory=list)

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field


class SymbolConfigOut(BaseModel):
    name: str
    point_size: float
    contract_size: float
    default_spread_points: float
    timezone: str
    has_data: bool = False
    first_bar: Optional[datetime] = None
    last_bar: Optional[datetime] = None


class SymbolConfigUpdate(BaseModel):
    point_size: Optional[float] = None
    contract_size: Optional[float] = None
    default_spread_points: Optional[float] = None
    timezone: Optional[str] = None


class ImportResponse(BaseModel):
    symbol: str
    imported_rows: int
    rejected_count: int
    rejected_samples: list[dict]
    total_rows: int
    detected_format: str


class DownloadRequest(BaseModel):
    symbol: str
    date_from: datetime
    date_to: datetime
    pipet_scale: Optional[float] = None


class DownloadJobOut(BaseModel):
    id: str
    symbol: str
    date_from: datetime
    date_to: datetime
    status: str
    hours_total: int
    hours_done: int
    rows_imported: int
    error_message: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class SessionCreate(BaseModel):
    symbol: str
    start_time: datetime
    starting_balance: float = 10000.0
    name: str = "Session"


class SessionOut(BaseModel):
    id: str
    name: str
    symbol: str
    start_time: datetime
    cursor_time: datetime
    starting_balance: float
    balance: float
    equity: Optional[float] = None
    has_open_positions: bool = False
    created_at: datetime
    updated_at: datetime
    quote: Optional[dict] = None


class StepRequest(BaseModel):
    tf: str = "M1"  # step resolution: how far one step moves the cursor
    n: int = Field(1, ge=1, le=100000)
    display_tf: Optional[str] = None  # timeframe of the candles returned (defaults to tf)


class JumpRequest(BaseModel):
    timestamp: datetime
    force: bool = False


class OrderRequest(BaseModel):
    side: Literal["buy", "sell"]
    lots: float
    sl: Optional[float] = None
    tp: Optional[float] = None
    order_type: Literal["market", "limit", "stop"] = "market"
    price: Optional[float] = None  # required for limit/stop


class OrderUpdate(BaseModel):
    price: Optional[float] = None
    sl: Optional[float] = None
    tp: Optional[float] = None
    clear_sl: bool = False
    clear_tp: bool = False


class PositionUpdate(BaseModel):
    sl: Optional[float] = None
    tp: Optional[float] = None
    clear_sl: bool = False
    clear_tp: bool = False


class PositionOut(BaseModel):
    id: str
    symbol: str
    side: str
    lots: float
    open_price: float
    open_time: datetime
    sl: Optional[float] = None
    tp: Optional[float] = None
    current_price: Optional[float] = None
    floating_pnl: Optional[float] = None


class TradeOut(BaseModel):
    id: str
    position_id: str
    symbol: str
    side: str
    lots: float
    open_price: float
    close_price: float
    open_time: datetime
    close_time: datetime
    sl: Optional[float] = None
    tp: Optional[float] = None
    pnl: float
    close_reason: str


class StepEventOut(BaseModel):
    type: str  # "closed"
    trade: TradeOut


class StepResponse(BaseModel):
    cursor_time: datetime
    candles: dict  # {tf: [OHLC dict...]} for the displayed tf only, keyed by tf
    events: list[StepEventOut]
    positions: list[PositionOut]
    balance: float
    equity: float
    end_of_data: bool


class DrawingIn(BaseModel):
    id: Optional[str] = None
    overlay_name: str
    points: list[dict]
    styles: Optional[dict] = None
    lock: bool = False
    visible: bool = True
    group_id: Optional[str] = None
    extend_data: Optional[dict] = None


class DrawingOut(BaseModel):
    id: str
    symbol: str
    overlay_name: str
    points: list[dict]
    styles: Optional[dict] = None
    lock: bool
    visible: bool
    group_id: Optional[str] = None
    extend_data: Optional[dict] = None


class StatsOut(BaseModel):
    total_trades: int
    win_rate: float
    net_pnl: float
    profit_factor: Optional[float]
    avg_win: float
    avg_loss: float
    avg_r: Optional[float]
    max_drawdown: float
    equity_curve: list[dict]

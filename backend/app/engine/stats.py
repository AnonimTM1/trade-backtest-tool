"""Pure-python trade statistics. No FastAPI / DB imports."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional, Protocol


class TradeLike(Protocol):
    side: str
    lots: float
    open_price: float
    close_price: float
    sl: Optional[float]
    pnl: float
    close_time: datetime
    contract_size: float


@dataclass
class Stats:
    total_trades: int
    win_rate: float
    net_pnl: float
    profit_factor: Optional[float]
    avg_win: float
    avg_loss: float
    avg_r: Optional[float]
    max_drawdown: float
    equity_curve: list[dict]


def compute_stats(trades: list[TradeLike], starting_balance: float) -> Stats:
    trades = sorted(trades, key=lambda t: t.close_time)
    total = len(trades)
    if total == 0:
        return Stats(
            total_trades=0, win_rate=0.0, net_pnl=0.0, profit_factor=None,
            avg_win=0.0, avg_loss=0.0, avg_r=None, max_drawdown=0.0,
            equity_curve=[{"time": None, "equity": starting_balance}],
        )

    wins = [t for t in trades if t.pnl > 0]
    losses = [t for t in trades if t.pnl < 0]
    net_pnl = sum(t.pnl for t in trades)
    win_rate = (len(wins) / total) * 100.0
    avg_win = (sum(t.pnl for t in wins) / len(wins)) if wins else 0.0
    avg_loss = (sum(t.pnl for t in losses) / len(losses)) if losses else 0.0
    gross_win = sum(t.pnl for t in wins)
    gross_loss = abs(sum(t.pnl for t in losses))
    profit_factor = (gross_win / gross_loss) if gross_loss > 0 else None

    r_multiples = []
    for t in trades:
        if t.sl is None:
            continue
        risk = abs(t.open_price - t.sl) * t.lots * t.contract_size
        if risk > 0:
            r_multiples.append(t.pnl / risk)
    avg_r = (sum(r_multiples) / len(r_multiples)) if r_multiples else None

    equity = starting_balance
    equity_curve = [{"time": None, "equity": equity}]
    peak = equity
    max_dd = 0.0
    for t in trades:
        equity += t.pnl
        equity_curve.append({"time": t.close_time.isoformat(), "equity": equity})
        peak = max(peak, equity)
        max_dd = max(max_dd, peak - equity)

    return Stats(
        total_trades=total,
        win_rate=win_rate,
        net_pnl=net_pnl,
        profit_factor=profit_factor,
        avg_win=avg_win,
        avg_loss=avg_loss,
        avg_r=avg_r,
        max_drawdown=max_dd,
        equity_curve=equity_curve,
    )

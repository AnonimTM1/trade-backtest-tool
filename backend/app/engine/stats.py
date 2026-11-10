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
    expectancy: float = 0.0
    largest_win: float = 0.0
    largest_loss: float = 0.0
    max_consecutive_wins: int = 0
    max_consecutive_losses: int = 0
    return_pct: float = 0.0
    max_drawdown_pct: float = 0.0
    long_trades: int = 0
    short_trades: int = 0
    long_win_rate: float = 0.0
    short_win_rate: float = 0.0


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
    max_dd_pct = 0.0
    for t in trades:
        equity += t.pnl
        equity_curve.append({"time": t.close_time.isoformat(), "equity": equity})
        peak = max(peak, equity)
        max_dd = max(max_dd, peak - equity)
        if peak > 0:
            max_dd_pct = max(max_dd_pct, (peak - equity) / peak * 100.0)

    max_w = max_l = cur_w = cur_l = 0
    for t in trades:
        if t.pnl > 0:
            cur_w, cur_l = cur_w + 1, 0
        elif t.pnl < 0:
            cur_w, cur_l = 0, cur_l + 1
        else:
            cur_w = cur_l = 0
        max_w, max_l = max(max_w, cur_w), max(max_l, cur_l)

    longs = [t for t in trades if t.side == "buy"]
    shorts = [t for t in trades if t.side == "sell"]

    def _wr(group) -> float:
        return (sum(1 for t in group if t.pnl > 0) / len(group) * 100.0) if group else 0.0

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
        expectancy=net_pnl / total,
        largest_win=max((t.pnl for t in wins), default=0.0),
        largest_loss=min((t.pnl for t in losses), default=0.0),
        max_consecutive_wins=max_w,
        max_consecutive_losses=max_l,
        return_pct=(net_pnl / starting_balance * 100.0) if starting_balance else 0.0,
        max_drawdown_pct=max_dd_pct,
        long_trades=len(longs),
        short_trades=len(shorts),
        long_win_rate=_wr(longs),
        short_win_rate=_wr(shorts),
    )

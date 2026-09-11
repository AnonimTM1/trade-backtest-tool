from dataclasses import dataclass
from datetime import datetime, timedelta

from app.engine.stats import compute_stats


@dataclass
class T:
    side: str
    lots: float
    open_price: float
    close_price: float
    sl: float | None
    pnl: float
    close_time: datetime
    contract_size: float = 100.0


def test_empty_trades():
    s = compute_stats([], 10000)
    assert s.total_trades == 0
    assert s.net_pnl == 0.0
    assert s.profit_factor is None


def test_basic_stats():
    base = datetime(2024, 1, 1)
    trades = [
        T("buy", 1, 2000, 2010, 1995, 1000.0, base + timedelta(minutes=1)),  # win, risk=500 -> R=2
        T("sell", 1, 2010, 2020, 2015, -1000.0, base + timedelta(minutes=2)),  # loss, risk=500 -> R=-2
        T("buy", 1, 2000, 2005, None, 500.0, base + timedelta(minutes=3)),  # win, no sl
    ]
    s = compute_stats(trades, 10000)
    assert s.total_trades == 3
    assert s.win_rate == (2 / 3) * 100
    assert s.net_pnl == 500.0
    assert s.profit_factor == 1500.0 / 1000.0
    assert s.avg_win == 750.0
    assert s.avg_loss == -1000.0
    assert s.avg_r == 0.0  # (2 + -2) / 2
    assert s.max_drawdown == 1000.0  # peak 11000 after trade1, drop to 10000 after trade2
    assert s.equity_curve[-1]["equity"] == 10500.0

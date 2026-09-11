#!/usr/bin/env python3
"""Standalone script to export M1 history from a running MetaTrader5 terminal
into the generic CSV format this app's importer understands.

Run this on your WINDOWS HOST (outside Docker) — the `MetaTrader5` python
package only works on Windows and talks to a locally installed/running MT5
terminal. It is NOT used inside the container at all.

Usage:
    python tools/export_mt5.py --symbol XAUUSD --from 2021-01-01 --to 2024-01-01 [--out ../data/raw]

Requirements (install on the Windows host, not in Docker):
    pip install MetaTrader5 pandas

Output:
    Writes <out>/<SYMBOL>_<from>_<to>.csv in the generic format:
        time,open,high,low,close,volume,spread
    with `time` as ISO-8601 and `spread` in points (as reported by MT5's
    M1 rates, which already carry the broker's historical spread), ready to
    drop into ./data/raw/ and import via the app's Import screen/endpoint.
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Export MT5 M1 history to generic CSV")
    p.add_argument("--symbol", required=True, help="MT5 symbol name, e.g. XAUUSD")
    p.add_argument("--from", dest="date_from", required=True, help="Start date, YYYY-MM-DD")
    p.add_argument("--to", dest="date_to", required=True, help="End date, YYYY-MM-DD")
    p.add_argument(
        "--out",
        default=str(Path(__file__).resolve().parent.parent / "data" / "raw"),
        help="Output directory (default: ../data/raw relative to this script)",
    )
    p.add_argument("--login", type=int, default=None, help="Optional MT5 account login to initialize with")
    p.add_argument("--password", default=None, help="Optional MT5 account password")
    p.add_argument("--server", default=None, help="Optional MT5 server name")
    return p.parse_args()


def main() -> int:
    args = parse_args()

    try:
        import MetaTrader5 as mt5  # type: ignore
    except ImportError:
        print(
            "The MetaTrader5 package is not installed, or you are not running this "
            "on Windows. Install it with:\n\n    pip install MetaTrader5 pandas\n\n"
            "This script must run on your Windows host, outside Docker.",
            file=sys.stderr,
        )
        return 1

    import pandas as pd

    init_kwargs = {}
    if args.login:
        init_kwargs["login"] = args.login
    if args.password:
        init_kwargs["password"] = args.password
    if args.server:
        init_kwargs["server"] = args.server

    if not mt5.initialize(**init_kwargs):
        print(f"mt5.initialize() failed: {mt5.last_error()}", file=sys.stderr)
        return 1

    try:
        if not mt5.symbol_select(args.symbol, True):
            print(f"Could not select symbol {args.symbol!r}: {mt5.last_error()}", file=sys.stderr)
            return 1

        date_from = datetime.strptime(args.date_from, "%Y-%m-%d")
        date_to = datetime.strptime(args.date_to, "%Y-%m-%d")

        print(f"Fetching {args.symbol} M1 bars from {date_from} to {date_to} ...")
        rates = mt5.copy_rates_range(args.symbol, mt5.TIMEFRAME_M1, date_from, date_to)
        if rates is None or len(rates) == 0:
            print(f"No data returned: {mt5.last_error()}", file=sys.stderr)
            return 1

        df = pd.DataFrame(rates)
        df["time"] = pd.to_datetime(df["time"], unit="s")
        out_df = pd.DataFrame(
            {
                "time": df["time"].dt.strftime("%Y-%m-%dT%H:%M:%S"),
                "open": df["open"],
                "high": df["high"],
                "low": df["low"],
                "close": df["close"],
                "volume": df["tick_volume"],
                "spread": df["spread"],
            }
        )

        out_dir = Path(args.out)
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"{args.symbol}_{args.date_from}_{args.date_to}.csv"
        out_df.to_csv(out_path, index=False)
        print(f"Wrote {len(out_df)} rows to {out_path}")
        return 0
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())

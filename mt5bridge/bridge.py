"""Read-only MetaTrader 5 market-data bridge.

The MetaTrader5 Python package only runs on Windows next to an installed,
logged-in MT5 terminal, while the app itself runs in Docker (Linux). This tiny
HTTP service runs on the Windows host and exposes quotes and bar/tick history
as JSON. It never sends, modifies or closes orders: the app's live mode is
paper trading on real prices.

Process layout (why it isn't one simple script):
  MT5 calls can block for seconds to a minute while the terminal downloads
  history from the broker, and while blocked the MetaTrader5 module holds
  Python's GIL, freezing every thread of that process. So the HTTP process
  never calls MT5 itself. Two worker processes, each with its own MT5
  connection, do:
    * quotes  - keeps the quotes of watched symbols fresh (every 100 ms) and
                answers short queries (status, symbol info, recent ticks);
    * history - bars, the symbol list and long tick ranges (may download).
  /tick is answered from the in-memory quote cache, so the app keeps getting
  the last known price ("stale": true) instead of timing out.

All timestamps leaving the bridge are real UTC epoch milliseconds. MT5 reports
times in the broker's *server* time; see ``ServerClock`` for the conversion.

Run:  mt5bridge\\.venv\\Scripts\\python.exe mt5bridge\\bridge.py [--host 127.0.0.1] [--port 8765]
Env:  MT5_PATH        optional path to terminal64.exe
      MT5_UTC_OFFSET  force a fixed server offset in hours (e.g. "2"), or "nyclose"
"""
from __future__ import annotations

import argparse
import itertools
import json
import multiprocessing as mp
import os
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
STATE_FILE = Path(__file__).with_name(".server_offset.json")
TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"]
MAX_BARS = 20000
MAX_TICKS = 200000
QUICK_TIMEOUT_S = 8
HISTORY_TIMEOUT_S = 120
SHORT_TICK_RANGE_S = 3600  # tick queries up to this long go to the quotes worker
STALE_AFTER_S = 1.5
WATCH_FOR_S = 120


class BridgeError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------------------
# Server time <-> UTC
# ---------------------------------------------------------------------------


def _ny_close_offset(utc_s: float) -> int:
    """Offset (s) of the common "New York close at 00:00" server clock
    (UTC+2 in winter, UTC+3 during US daylight saving)."""
    off = datetime.fromtimestamp(utc_s, timezone.utc).astimezone(NY).utcoffset()
    return int(off.total_seconds()) + 7 * 3600


class ServerClock:
    """Works out how far the broker's server clock is from UTC.

    Detection: the freshest tick across Market Watch is compared with the
    real clock. When the market is open the difference is (almost exactly) a
    whole number of half hours; that value is cached on disk so it is still
    known over the weekend. If it matches the NY-close convention, that
    DST-aware rule is used for history too, so bars on both sides of a DST
    change line up correctly; otherwise the fixed offset is used.
    """

    def __init__(self):
        self.mode = "fixed"  # "fixed" | "nyclose"
        self.fixed = 0
        self.source = "default"
        forced = os.environ.get("MT5_UTC_OFFSET", "").strip().lower()
        if forced == "nyclose":
            self.mode, self.source = "nyclose", "env"
        elif forced:
            self.fixed, self.source = int(float(forced) * 3600), "env"
        elif STATE_FILE.exists():
            try:
                st = json.loads(STATE_FILE.read_text())
                self.mode, self.fixed, self.source = st["mode"], int(st["fixed"]), "cached"
            except Exception:
                pass

    def detect(self, newest_server_s: float) -> None:
        if self.source == "env" or not newest_server_s:
            return
        raw = newest_server_s - time.time()
        rounded = round(raw / 1800) * 1800
        if abs(raw - rounded) > 90:  # stale tick (market closed): can't tell
            return
        mode = "nyclose" if rounded == _ny_close_offset(time.time()) else "fixed"
        if (mode, rounded) != (self.mode, self.fixed) or self.source != "detected":
            self.mode, self.fixed, self.source = mode, int(rounded), "detected"
            try:
                STATE_FILE.write_text(json.dumps({"mode": mode, "fixed": int(rounded)}))
            except OSError:
                pass

    def offset_at_utc(self, utc_s: float) -> int:
        return _ny_close_offset(utc_s) if self.mode == "nyclose" else self.fixed

    def to_utc(self, server_s: float) -> float:
        # offset(t) only changes at DST boundaries, so one correction step is exact
        # except inside the (non-existent / repeated) changeover hour.
        guess = server_s - self.offset_at_utc(server_s)
        return server_s - self.offset_at_utc(guess)

    def to_server(self, utc_s: float) -> float:
        return utc_s + self.offset_at_utc(utc_s)

    def describe(self) -> dict:
        return {"mode": self.mode, "utc_offset_hours": self.offset_at_utc(time.time()) / 3600, "source": self.source}


clock = ServerClock()


# ---------------------------------------------------------------------------
# Worker processes (the only places that call MetaTrader5)
# ---------------------------------------------------------------------------


def _worker_main(conn, path, pump: bool):
    import MetaTrader5 as m

    tf_codes = {tf: getattr(m, f"TIMEFRAME_{tf}") for tf in TIMEFRAMES}
    watched: dict[str, float] = {}
    info_cache: dict[str, tuple] = {}
    last_pump = 0.0

    def ensure():
        if m.terminal_info() is None and not (m.initialize(path) if path else m.initialize()):
            raise ConnectionError(f"MetaTrader 5 is not reachable: {m.last_error()}. Open MT5 and log in.")

    def sym(name):
        info = m.symbol_info(name)
        if info is None:
            raise LookupError(f"Unknown MT5 symbol {name!r}")
        if not info.visible:
            m.symbol_select(name, True)  # may make MT5 download data: fine, we're a worker
            info = m.symbol_info(name) or info
        info_cache[name] = (info.point, info.digits)
        return info

    def quote(name):
        t = m.symbol_info_tick(name)
        if t is None or not t.time_msc:
            return None
        point, digits = info_cache.get(name) or (lambda i: (i.point, i.digits))(sym(name))
        return (int(t.time_msc), float(t.bid), float(t.ask), point, digits)

    def handle(kind, args):
        ensure()
        if kind == "status":
            term, acc = m.terminal_info(), m.account_info()
            account = None
            if acc is not None:
                mode = {0: "demo", 1: "contest", 2: "real"}.get(acc.trade_mode, str(acc.trade_mode))
                account = {"login": acc.login, "server": acc.server, "mode": mode, "currency": acc.currency, "company": acc.company}
            return {"connected": bool(term and term.connected), "terminal": term.name if term else None, "account": account}
        if kind == "newest":  # freshest tick time across Market Watch (for clock detection)
            newest = 0
            for s in m.symbols_get() or []:
                if s.visible:
                    t = m.symbol_info_tick(s.name)
                    if t is not None and t.time_msc:
                        newest = max(newest, t.time_msc)
            return newest / 1000.0
        if kind == "symbol":
            i = sym(args[0])
            return {
                "name": i.name, "description": i.description, "digits": i.digits, "point": i.point,
                "contract_size": i.trade_contract_size, "spread": i.spread, "currency_profit": i.currency_profit,
                "volume_min": i.volume_min, "volume_step": i.volume_step,
            }
        if kind == "tick":
            name = args[0]
            sym(name)
            watched[name] = time.time()
            q = quote(name)
            for _ in range(15):  # a symbol just added to Market Watch needs a moment for its first quote
                if q is not None:
                    break
                time.sleep(0.1)
                q = quote(name)
            if q is None:
                raise LookupError(f"No quote for {name}")
            return q
        if kind == "rates":
            name, tf, server_before, count = args
            sym(name)
            arr = (m.copy_rates_from(name, tf_codes[tf], int(server_before), count) if server_before is not None
                   else m.copy_rates_from_pos(name, tf_codes[tf], 0, count))
            return [] if arr is None else [
                (float(r["time"]), float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"]),
                 float(r["tick_volume"]), float(r["spread"]))
                for r in arr
            ]
        if kind == "symbols":
            return [(x.name, x.description, x.path, bool(x.visible)) for x in (m.symbols_get() or [])]
        if kind == "ticks":
            name, frm, to, cap = args
            sym(name)
            arr = m.copy_ticks_range(name, int(frm), int(to), m.COPY_TICKS_INFO)
            rows = [] if arr is None else [(int(t["time_msc"]), float(t["bid"]), float(t["ask"])) for t in arr[-cap:]]
            return rows, arr is not None and len(arr) > cap
        raise ValueError(f"unknown request {kind!r}")

    while True:
        try:
            ready = conn.poll(0.1 if pump else None)
        except (EOFError, OSError):
            return
        if ready:
            try:
                msg = conn.recv()
            except (EOFError, OSError):
                return
            if msg[0] == "watch":
                watched[msg[1]] = time.time()
            else:
                req_id, kind, args = msg
                try:
                    conn.send(("resp", req_id, "ok", handle(kind, args)))
                except ConnectionError as e:
                    conn.send(("resp", req_id, "down", str(e)))
                except LookupError as e:
                    conn.send(("resp", req_id, "notfound", str(e)))
                except Exception as e:  # keep the worker alive
                    conn.send(("resp", req_id, "err", f"{type(e).__name__}: {e}"))
        if pump and time.time() - last_pump >= 0.1:
            last_pump = time.time()
            now = time.time()
            for name in [n for n, t in watched.items() if now - t > WATCH_FOR_S]:
                del watched[name]
            if watched:
                try:
                    ensure()
                    for name in list(watched):
                        q = quote(name)
                        if q is not None:
                            conn.send(("quote", name, q))
                except Exception:
                    pass


class Worker:
    """Main-process handle of a worker: request/response plus pushed quotes."""

    def __init__(self, name: str, pump: bool, on_quote=None):
        self.name = name
        self.pump = pump
        self.on_quote = on_quote
        self._send_lock = threading.Lock()
        self._start_lock = threading.Lock()
        self._pending: dict[int, list] = {}
        self._ids = itertools.count(1)
        self._proc = None
        self._conn = None

    def _ensure_started(self):
        with self._start_lock:
            if self._proc is not None and self._proc.is_alive():
                return
            parent, child = mp.Pipe()
            self._proc = mp.Process(target=_worker_main, args=(child, os.environ.get("MT5_PATH"), self.pump),
                                    name=f"mt5-{self.name}", daemon=True)
            self._proc.start()
            self._conn = parent
            threading.Thread(target=self._reader, args=(parent,), name=f"{self.name}-reader", daemon=True).start()

    def _reader(self, conn):
        while True:
            try:
                msg = conn.recv()  # blocking in C: releases the GIL
            except (EOFError, OSError):
                return
            if msg[0] == "quote":
                if self.on_quote:
                    self.on_quote(msg[1], msg[2])
            elif msg[0] == "resp":
                slot = self._pending.pop(msg[1], None)
                if slot is not None:
                    slot[1] = msg[2:]
                    slot[0].set()

    def send(self, msg):
        self._ensure_started()
        with self._send_lock:
            self._conn.send(msg)

    def call(self, kind: str, *args, timeout: float = QUICK_TIMEOUT_S):
        self._ensure_started()
        req_id = next(self._ids)
        slot = [threading.Event(), None]
        self._pending[req_id] = slot
        with self._send_lock:
            self._conn.send((req_id, kind, args))
        if not slot[0].wait(timeout):
            self._pending.pop(req_id, None)
            if timeout >= HISTORY_TIMEOUT_S:  # truly stuck: start a fresh worker next time
                self._proc.kill()
                self._proc = None
            raise BridgeError(504, "MetaTrader 5 is busy (downloading history?) - try again in a moment")
        status, payload = slot[1]
        if status == "ok":
            return payload
        raise BridgeError({"down": 503, "notfound": 404}.get(status, 502), payload)


_quotes: dict[str, tuple] = {}  # name -> (time_msc, bid, ask, point, digits, fetched_at)
_watch_sent: dict[str, float] = {}


def _on_quote(name, q):
    _quotes[name] = (*q, time.time())


quotes_worker = Worker("quotes", pump=True, on_quote=_on_quote)
history_worker = Worker("history", pump=False)
_last_detect = 0.0


def _maybe_detect_clock():
    global _last_detect
    if time.time() - _last_detect > 60:
        _last_detect = time.time()
        try:
            clock.detect(quotes_worker.call("newest"))
        except BridgeError:
            pass


# ---------------------------------------------------------------------------
# HTTP endpoints
# ---------------------------------------------------------------------------


def status(_q) -> dict:
    try:
        st = quotes_worker.call("status")
    except BridgeError as e:
        return {"connected": False, "error": str(e)}
    _maybe_detect_clock()
    return {**st, "clock": clock.describe(), "trading": "disabled (read-only bridge, paper trading only)"}


def symbols(_q) -> dict:
    rows = history_worker.call("symbols", timeout=60)
    out = [{"name": n, "description": d, "path": p, "visible": v} for n, d, p, v in rows]
    out.sort(key=lambda x: (not x["visible"], x["name"]))
    return {"symbols": out}


def symbol(q) -> dict:
    return quotes_worker.call("symbol", _name(q))


def _name(q) -> str:
    name = q.get("symbol", "")
    if not name:
        raise BridgeError(400, "symbol is required")
    return name


def tick(q) -> dict:
    """Answered from the quote cache that the quotes worker keeps fresh."""
    name = _name(q)
    now = time.time()
    if now - _watch_sent.get(name, 0) > 10:  # keep the symbol on the worker's watch list
        _watch_sent[name] = now
        if name in _quotes:
            quotes_worker.send(("watch", name))
    cached = _quotes.get(name)
    if cached is None:  # first request for this symbol
        t_ms, bid, ask, point, digits = quotes_worker.call("tick", name)
        cached = _quotes[name] = (t_ms, bid, ask, point, digits, time.time())
        _maybe_detect_clock()
    t_ms, bid, ask, point, digits, fetched = cached
    utc_s = clock.to_utc(t_ms / 1000.0)
    return {
        "time_ms": int(utc_s * 1000),
        "bid": bid,
        "ask": ask,
        "point": point,
        "digits": digits,
        "server_age_s": max(0.0, time.time() - utc_s),
        "stale": time.time() - fetched > STALE_AFTER_S,  # MT5 busy: last known quote
    }


def rates(q) -> dict:
    name = _name(q)
    tf = q.get("tf", "M1")
    if tf not in TIMEFRAMES:
        raise BridgeError(400, f"Unknown timeframe {tf!r}")
    count = max(1, min(int(q.get("count", 500)), MAX_BARS))
    before = q.get("before_ms")
    server_before = clock.to_server(int(before) / 1000.0) - 1 if before else None
    rows = history_worker.call("rates", name, tf, server_before, count, timeout=HISTORY_TIMEOUT_S)
    candles = []
    for t, o, h, l, c, v, sp in rows:
        ts = int(clock.to_utc(t) * 1000)
        if before and ts >= int(before):
            continue
        candles.append({"timestamp": ts, "open": o, "high": h, "low": l, "close": c, "volume": v, "spread": sp})
    return {"symbol": name, "tf": tf, "candles": candles}


def ticks(q) -> dict:
    """Bid/ask ticks in [from_ms, to_ms] (UTC), oldest first, capped at MAX_TICKS."""
    name = _name(q)
    frm = int(q.get("from_ms", 0)) / 1000.0
    to = int(q.get("to_ms", int(time.time() * 1000))) / 1000.0
    if to - frm > 7 * 86400:
        frm = to - 7 * 86400
    s_from, s_to = int(clock.to_server(frm)), int(clock.to_server(to)) + 1
    if to - frm <= SHORT_TICK_RANGE_S:  # the usual live poll
        raw, truncated = quotes_worker.call("ticks", name, s_from, s_to, MAX_TICKS)
    else:  # catching up after the app was closed: may need a download
        raw, truncated = history_worker.call("ticks", name, s_from, s_to, MAX_TICKS, timeout=HISTORY_TIMEOUT_S)
    lo, hi = int(frm * 1000), int(to * 1000)
    out = []
    for t_ms, bid, ask in raw:
        ms = int(clock.to_utc(t_ms / 1000.0) * 1000)
        if lo < ms <= hi and bid > 0:
            out.append([ms, bid, ask])
    return {"symbol": name, "ticks": out, "truncated": truncated}


ROUTES = {"/status": status, "/symbols": symbols, "/symbol": symbol, "/tick": tick, "/rates": rates, "/ticks": ticks}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        url = urlparse(self.path)
        fn = ROUTES.get(url.path)
        if fn is None:
            return self._send(404, {"detail": "not found"})
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            self._send(200, fn(q))
        except BridgeError as e:
            self._send(e.status, {"detail": str(e)})
        except (ValueError, TypeError) as e:
            self._send(400, {"detail": str(e)})
        except Exception as e:  # keep serving whatever happens
            self._send(500, {"detail": f"{type(e).__name__}: {e}"})

    def _send(self, code: int, body: dict):
        data = json.dumps(body).encode()
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass  # client gave up waiting

    def log_message(self, fmt, *args):  # quiet: errors only
        if args and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default=os.environ.get("MT5_BRIDGE_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("MT5_BRIDGE_PORT", "8765")))
    args = ap.parse_args()
    st = status({})
    print(json.dumps({k: v for k, v in st.items() if k != "account"} | {"account_mode": (st.get("account") or {}).get("mode")}, indent=2))
    history_worker.call("status")  # start the history worker up front
    print(f"MT5 bridge (read-only) listening on http://{args.host}:{args.port}")
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    mp.freeze_support()
    main()

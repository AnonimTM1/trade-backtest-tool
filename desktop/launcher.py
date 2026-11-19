"""Trading Wiev desktop launcher (the entry point of TradingWiev.exe).

Double-click to start: runs the backend on a free local port, starts the
read-only MT5 bridge when MetaTrader 5 is installed, and opens the app in the
default browser. Close the console window to quit.

Data (imported/downloaded bars, sessions, drawings, news) lives in a `data`
folder next to the exe, so the exe can be replaced or moved together with its
data without losing anything.
"""
from __future__ import annotations

import json
import multiprocessing as mp
import os
import shutil
import socket
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

if not getattr(sys, "frozen", False):  # running from source: make the packages importable
    _root = Path(__file__).resolve().parents[1]
    sys.path[:0] = [str(_root / "backend"), str(_root / "mt5bridge")]

APP_NAME = "Trading Wiev"
PREFERRED_PORTS = list(range(8000, 8011))
BRIDGE_PORT = int(os.environ.get("MT5_BRIDGE_PORT", "8765"))


def exe_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[1]


def bundle_dir() -> Path:
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1]))


def _get_json(url: str, timeout: float = 1.5):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read())
    except Exception:
        return None


def _port_free(port: int) -> bool:
    # Something already answering there (e.g. the Docker copy on 0.0.0.0:8000)? Windows
    # still lets us bind 127.0.0.1 on top of it, so a bind test alone isn't enough.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as c:
        c.settimeout(0.3)
        if c.connect_ex(("127.0.0.1", port)) == 0:
            return False
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if os.name == "nt":
            s.setsockopt(socket.SOL_SOCKET, getattr(socket, "SO_EXCLUSIVEADDRUSE", -5), 1)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes

        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        code = ctypes.c_ulong()
        ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
        ctypes.windll.kernel32.CloseHandle(handle)
        return code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def seed_data(data: Path) -> None:
    """First run: copy the bundled economic-calendar history into the data folder."""
    news = data / "news"
    news.mkdir(parents=True, exist_ok=True)
    for name in ("forexfactory_news.csv", "ff_feed_archive.json"):
        src = bundle_dir() / "seed" / "news" / name
        if src.exists() and not (news / name).exists():
            shutil.copy2(src, news / name)


def start_bridge() -> str | None:
    """Start the MT5 bridge in this process (worker processes do the MT5 calls).
    Returns the bridge URL, or None when MT5 isn't available here."""
    url = f"http://127.0.0.1:{BRIDGE_PORT}"
    if _get_json(url + "/status", timeout=2) is not None:
        print(f"  MT5 bridge : already running at {url}")
        return url
    if os.name != "nt":
        return None
    try:
        import bridge  # mt5bridge/bridge.py, bundled
    except Exception as e:  # MetaTrader5 package missing / not Windows
        print(f"  MT5 bridge : unavailable ({e})")
        return None
    if not _port_free(BRIDGE_PORT):
        print(f"  MT5 bridge : port {BRIDGE_PORT} is busy, live mode disabled")
        return None
    threading.Thread(target=bridge.serve, args=("127.0.0.1", BRIDGE_PORT), kwargs={"quiet": True},
                     name="mt5-bridge", daemon=True).start()
    return url


def main() -> None:
    mp.freeze_support()  # MT5 bridge workers re-launch this exe; must run first
    try:
        sys.stdout.reconfigure(line_buffering=True)  # show progress immediately in the console
    except Exception:
        pass

    data = exe_dir() / "data"
    data.mkdir(parents=True, exist_ok=True)
    os.environ["DATA_DIR"] = str(data)
    lock = data / ".desktop.json"

    # Already running? Just open it again.
    try:
        st = json.loads(lock.read_text())
        if _pid_alive(int(st["pid"])) and _get_json(f"http://127.0.0.1:{st['port']}/api/health"):
            print(f"{APP_NAME} is already running - opening http://127.0.0.1:{st['port']}")
            webbrowser.open(f"http://127.0.0.1:{st['port']}")
            time.sleep(2)
            return
    except Exception:
        pass

    if os.name == "nt":
        os.system(f"title {APP_NAME}")
    print(f"{APP_NAME}\n{'=' * len(APP_NAME)}")
    print(f"  Data folder: {data}")
    seed_data(data)

    bridge_url = start_bridge()
    if bridge_url:
        os.environ["MT5_BRIDGE_URL"] = bridge_url
        print(f"  MT5 bridge : {bridge_url} (read-only, paper trading)")

    port = next((p for p in PREFERRED_PORTS if _port_free(p)), None)
    if port is None:
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
    url = f"http://127.0.0.1:{port}"
    lock.write_text(json.dumps({"pid": os.getpid(), "port": port}))

    import uvicorn

    from app.main import app  # imported after DATA_DIR / MT5_BRIDGE_URL are set

    def open_browser():
        for _ in range(100):
            if _get_json(url + "/api/health", timeout=1):
                print(f"\n  Running at {url}\n  Close this window to quit.\n")
                if not os.environ.get("TW_NO_BROWSER"):
                    webbrowser.open(url)
                return
            time.sleep(0.2)

    threading.Thread(target=open_browser, daemon=True).start()
    try:
        uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning", access_log=False)
    finally:
        try:
            lock.unlink()
        except OSError:
            pass


if __name__ == "__main__":
    main()

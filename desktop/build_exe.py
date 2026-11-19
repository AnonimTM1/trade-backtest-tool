"""Builds dist/TradingWiev.exe.

  1. frontend  -> desktop/build/static   (local npm if available, otherwise Docker)
  2. icon      -> desktop/icon.ico       (only if missing; needs Pillow)
  3. PyInstaller with desktop/TradingWiev.spec

Run with the backend's Python (it needs the backend requirements plus
pyinstaller, MetaTrader5 and pillow):
  backend\\.venv\\Scripts\\python.exe desktop\\build_exe.py
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
STATIC = HERE / "build" / "static"


def run(cmd, **kw):
    print("+", " ".join(map(str, cmd)), flush=True)
    subprocess.run(cmd, check=True, **kw)


def build_frontend():
    if STATIC.exists():
        shutil.rmtree(STATIC)
    npm = shutil.which("npm")
    if npm:
        run([npm, "ci", "--no-audit", "--no-fund"], cwd=ROOT / "frontend")
        run([npm, "run", "build"], cwd=ROOT / "frontend")
        shutil.copytree(ROOT / "frontend" / "dist", STATIC)
        return
    docker = shutil.which("docker")
    if not docker:
        sys.exit("Need either Node.js (npm) or Docker to build the frontend.")
    run([docker, "build", "-f", "Dockerfile.fast", "--target", "frontend-build", "-t", "trading-wiev-frontend:exe", "."], cwd=ROOT)
    cid = subprocess.run([docker, "create", "trading-wiev-frontend:exe"], check=True, capture_output=True, text=True).stdout.strip()
    try:
        STATIC.parent.mkdir(parents=True, exist_ok=True)
        run([docker, "cp", f"{cid}:/frontend/dist", str(STATIC)])
    finally:
        subprocess.run([docker, "rm", cid], capture_output=True)


def build_icon():
    if (HERE / "icon.ico").exists():
        return
    run([sys.executable, str(HERE / "make_icon.py")])


def build_exe():
    run([sys.executable, "-m", "PyInstaller", str(HERE / "TradingWiev.spec"), "--noconfirm",
         "--distpath", str(ROOT / "dist"), "--workpath", str(HERE / "build" / "pyinstaller")], cwd=ROOT)
    print("\nBuilt", ROOT / "dist" / "TradingWiev.exe")


if __name__ == "__main__":
    build_frontend()
    build_icon()
    build_exe()

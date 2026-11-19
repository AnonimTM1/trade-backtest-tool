@echo off
rem Starts the read-only MetaTrader 5 bridge used by the app's Live mode.
rem MetaTrader 5 must be open and logged in. Close this window to stop it.
cd /d "%~dp0mt5bridge"
if not exist ".venv\Scripts\python.exe" (
  echo First run: creating the Python environment...
  py -3 -m venv .venv || python -m venv .venv
  ".venv\Scripts\python.exe" -m pip install --retries 10 --timeout 60 -r requirements.txt
)
title MT5 bridge (read-only)
".venv\Scripts\python.exe" bridge.py %*
pause

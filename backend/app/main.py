from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.responses import FileResponse

from app.api import drawings, import_, news, sessions, symbols
from app.db.database import init_db

app = FastAPI(title="Trading Wiev — Bar Replay Backtester")

init_db()

app.include_router(symbols.router)
app.include_router(import_.router)
app.include_router(sessions.router)
app.include_router(drawings.router)
app.include_router(news.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}


STATIC_DIR = Path(__file__).resolve().parent / "static"

if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        candidate = STATIC_DIR / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(STATIC_DIR / "index.html")

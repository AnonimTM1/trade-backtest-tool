import os
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR", "/app/data"))
RAW_DIR = DATA_DIR / "raw"
PARQUET_DIR = DATA_DIR / "parquet"
DB_PATH = DATA_DIR / "app.db"

RAW_DIR.mkdir(parents=True, exist_ok=True)
PARQUET_DIR.mkdir(parents=True, exist_ok=True)
DATA_DIR.mkdir(parents=True, exist_ok=True)

BASE_TIMEFRAME = "M1"

TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"]

TIMEFRAME_MINUTES = {
    "M1": 1,
    "M5": 5,
    "M15": 15,
    "M30": 30,
    "H1": 60,
    "H4": 240,
    "D1": 1440,
}

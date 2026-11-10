"""CSV parsing for historical OHLC data.

Supports two input formats (auto-detected):
  1. MT5 History Center export (tab-separated):
       <DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>
       dates like 2024.01.02, times like 00:00:00
  2. Generic CSV:
       time,open,high,low,close[,volume][,spread]
       time as ISO-8601 or unix seconds
"""
from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field
from datetime import datetime, timezone


class CsvImportError(Exception):
    pass


@dataclass
class ImportResult:
    rows: list[dict]  # sorted, validated rows: timestamp(datetime), open, high, low, close, volume, spread
    rejected: list[dict] = field(default_factory=list)  # {row_number, reason, raw}
    detected_format: str = ""


def _sniff_dialect(sample: str) -> str:
    """Return 'mt5' or 'generic' based on header line."""
    first_line = sample.splitlines()[0] if sample else ""
    if first_line.startswith("<DATE>") or "\t" in first_line and "<DATE>" in first_line.upper():
        return "mt5"
    if "\t" in first_line:
        return "mt5"
    return "generic"


def _parse_mt5_datetime(date_str: str, time_str: str) -> datetime:
    # date like 2024.01.02, time like 00:00:00
    date_str = date_str.strip()
    time_str = time_str.strip()
    try:
        return datetime.strptime(f"{date_str} {time_str}", "%Y.%m.%d %H:%M:%S")
    except ValueError:
        return datetime.strptime(f"{date_str} {time_str}", "%Y.%m.%d %H:%M")


def _parse_generic_time(value: str) -> datetime:
    value = value.strip()
    if value.isdigit() or (value.startswith("-") and value[1:].isdigit()):
        return datetime.fromtimestamp(int(value), tz=timezone.utc).replace(tzinfo=None)
    # try float unix seconds
    try:
        f = float(value)
        return datetime.fromtimestamp(f, tz=timezone.utc).replace(tzinfo=None)
    except ValueError:
        pass
    # ISO-8601, several common variants
    for fmt in (
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d",
    ):
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    # last resort: fromisoformat handles offsets like +00:00
    try:
        v = value.replace("Z", "+00:00")
        dt = datetime.fromisoformat(v)
        return dt.replace(tzinfo=None)
    except ValueError as e:
        raise CsvImportError(f"Unrecognized time format: {value!r}") from e


def parse_csv_bytes(raw: bytes, default_spread_points: float = 0.0) -> ImportResult:
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")

    text = text.strip()
    if not text:
        raise CsvImportError("File is empty")

    fmt = _sniff_dialect(text)
    if fmt == "mt5":
        rows, rejected = _parse_mt5(text)
    else:
        rows, rejected = _parse_generic(text, default_spread_points)

    if not rows:
        raise CsvImportError("No valid rows found in file")

    # sort by timestamp, dedupe (keep first), validate ordering after sort
    rows.sort(key=lambda r: r["timestamp"])
    deduped = []
    seen = set()
    for r in rows:
        if r["timestamp"] in seen:
            rejected.append({"reason": "duplicate timestamp", "raw": str(r)})
            continue
        seen.add(r["timestamp"])
        deduped.append(r)

    validated, val_rejected = _validate_ohlc(deduped)
    rejected.extend(val_rejected)

    return ImportResult(rows=validated, rejected=rejected, detected_format=fmt)


def _parse_mt5(text: str) -> tuple[list[dict], list[dict]]:
    reader = csv.reader(io.StringIO(text), delimiter="\t")
    header = next(reader, None)
    if header is None:
        raise CsvImportError("Empty MT5 file")
    header = [h.strip().strip('"').upper() for h in header]
    try:
        idx = {name: header.index(name) for name in ("<DATE>", "<TIME>", "<OPEN>", "<HIGH>", "<LOW>", "<CLOSE>")}
    except ValueError as e:
        raise CsvImportError(f"MT5 header missing required column: {e}") from e
    spread_idx = header.index("<SPREAD>") if "<SPREAD>" in header else None
    vol_idx = header.index("<TICKVOL>") if "<TICKVOL>" in header else (header.index("<VOL>") if "<VOL>" in header else None)

    rows, rejected = [], []
    for i, raw_row in enumerate(reader, start=2):
        if not raw_row or all(not c.strip() for c in raw_row):
            continue
        try:
            ts = _parse_mt5_datetime(raw_row[idx["<DATE>"]], raw_row[idx["<TIME>"]])
            o = float(raw_row[idx["<OPEN>"]])
            h = float(raw_row[idx["<HIGH>"]])
            l = float(raw_row[idx["<LOW>"]])
            c = float(raw_row[idx["<CLOSE>"]])
            vol = float(raw_row[vol_idx]) if vol_idx is not None and vol_idx < len(raw_row) and raw_row[vol_idx].strip() else 0.0
            spread = float(raw_row[spread_idx]) if spread_idx is not None and spread_idx < len(raw_row) and raw_row[spread_idx].strip() else None
            rows.append({"timestamp": ts, "open": o, "high": h, "low": l, "close": c, "volume": vol, "spread": spread})
        except (ValueError, IndexError) as e:
            rejected.append({"row_number": i, "reason": str(e), "raw": "\t".join(raw_row)})
    return rows, rejected


def _parse_generic(text: str, default_spread_points: float) -> tuple[list[dict], list[dict]]:
    sample_line = text.splitlines()[0]
    delimiter = "," if "," in sample_line else ("\t" if "\t" in sample_line else ",")
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    header = next(reader, None)
    if header is None:
        raise CsvImportError("Empty CSV file")
    header_l = [h.strip().lower() for h in header]
    required = ("time", "open", "high", "low", "close")
    if not all(col in header_l for col in required):
        raise CsvImportError(
            f"Generic CSV header must contain {required}, got {header_l}"
        )
    idx = {name: header_l.index(name) for name in required}
    vol_idx = header_l.index("volume") if "volume" in header_l else None
    spread_idx = header_l.index("spread") if "spread" in header_l else None

    rows, rejected = [], []
    for i, raw_row in enumerate(reader, start=2):
        if not raw_row or all(not c.strip() for c in raw_row):
            continue
        try:
            ts = _parse_generic_time(raw_row[idx["time"]])
            o = float(raw_row[idx["open"]])
            h = float(raw_row[idx["high"]])
            l = float(raw_row[idx["low"]])
            c = float(raw_row[idx["close"]])
            vol = float(raw_row[vol_idx]) if vol_idx is not None and vol_idx < len(raw_row) and raw_row[vol_idx].strip() else 0.0
            spread = float(raw_row[spread_idx]) if spread_idx is not None and spread_idx < len(raw_row) and raw_row[spread_idx].strip() else None
            rows.append({"timestamp": ts, "open": o, "high": h, "low": l, "close": c, "volume": vol, "spread": spread})
        except (ValueError, IndexError) as e:
            rejected.append({"row_number": i, "reason": str(e), "raw": delimiter.join(raw_row)})
    return rows, rejected


def _validate_ohlc(rows: list[dict]) -> tuple[list[dict], list[dict]]:
    valid, rejected = [], []
    for r in rows:
        o, h, l, c = r["open"], r["high"], r["low"], r["close"]
        if h < max(o, c):
            rejected.append({"reason": f"high {h} < max(open,close)", "raw": str(r)})
            continue
        if l > min(o, c):
            rejected.append({"reason": f"low {l} > min(open,close)", "raw": str(r)})
            continue
        if h < l:
            rejected.append({"reason": f"high {h} < low {l}", "raw": str(r)})
            continue
        valid.append(r)
    return valid, rejected

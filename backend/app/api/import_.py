from __future__ import annotations

from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.api import sessions_service
from app.api.schemas import DownloadJobOut, DownloadRequest, ImportResponse
from app.config import RAW_DIR
from app.data import dukascopy, parquet_store, resample
from app.data.csv_import import CsvImportError, parse_csv_bytes
from app.db.database import SessionLocal, get_db
from app.db.models import DownloadJob

router = APIRouter(prefix="/api/import", tags=["import"])


def _symbol_from_filename(filename: str) -> str:
    stem = Path(filename).stem
    return stem.upper()


def _do_import(db: DbSession, filename: str, raw_bytes: bytes, symbol_override: str | None) -> ImportResponse:
    symbol = (symbol_override or _symbol_from_filename(filename)).upper()
    cfg = sessions_service.get_or_create_symbol_config(db, symbol)
    try:
        result = parse_csv_bytes(raw_bytes, default_spread_points=cfg.default_spread_points)
    except CsvImportError as e:
        raise HTTPException(400, f"Failed to parse {filename}: {e}") from e

    total = parquet_store.save_m1(symbol, result.rows, merge=True)
    resample.invalidate_cache(symbol)

    return ImportResponse(
        symbol=symbol,
        imported_rows=len(result.rows),
        rejected_count=len(result.rejected),
        rejected_samples=result.rejected[:20],
        total_rows=total,
        detected_format=result.detected_format,
    )


@router.get("/raw")
def list_raw_files():
    if not RAW_DIR.exists():
        return {"files": []}
    files = sorted(p.name for p in RAW_DIR.iterdir() if p.is_file() and not p.name.startswith("."))
    return {"files": files}


@router.post("/raw/{filename}", response_model=ImportResponse)
def import_raw_file(filename: str, symbol: str | None = None, db: DbSession = Depends(get_db)):
    path = RAW_DIR / filename
    if not path.is_file():
        raise HTTPException(404, f"File not found in data/raw: {filename}")
    raw_bytes = path.read_bytes()
    return _do_import(db, filename, raw_bytes, symbol)


@router.post("/upload", response_model=ImportResponse)
async def upload_file(
    file: UploadFile = File(...),
    symbol: str | None = Form(None),
    db: DbSession = Depends(get_db),
):
    raw_bytes = await file.read()
    return _do_import(db, file.filename, raw_bytes, symbol)


@router.get("/dukascopy/symbols")
def dukascopy_symbols():
    return {"symbols": dukascopy.supported_symbols()}


def _job_to_out(job: DownloadJob) -> DownloadJobOut:
    return DownloadJobOut(
        id=job.id,
        symbol=job.symbol,
        date_from=job.date_from,
        date_to=job.date_to,
        status=job.status,
        hours_total=job.hours_total,
        hours_done=job.hours_done,
        rows_imported=job.rows_imported,
        error_message=job.error_message,
        created_at=job.created_at,
        updated_at=job.updated_at,
    )


async def _run_download_job(job_id: str, symbol: str, date_from: datetime, date_to: datetime,
                             point_size: float, pipet_scale: float | None):
    db = SessionLocal()
    try:
        job = db.get(DownloadJob, job_id)
        if job is None:
            return
        job.status = "running"
        db.commit()

        loop_progress = {"done": 0, "total": job.hours_total}

        def on_progress(done: int, total: int):
            loop_progress["done"] = done
            loop_progress["total"] = total
            if done % 25 == 0 or done == total:
                job.hours_done = done
                db.commit()

        try:
            rows = await dukascopy.download_m1_range(
                symbol, date_from, date_to, point_size, pipet_scale=pipet_scale, on_progress=on_progress
            )
        except dukascopy.DukascopyError as e:
            job.status = "error"
            job.error_message = str(e)
            db.commit()
            return

        job.hours_done = job.hours_total
        if rows:
            parquet_store.save_m1(symbol, rows, merge=True)
            resample.invalidate_cache(symbol)
        job.rows_imported = len(rows)
        job.status = "done"
        db.commit()
    except Exception as e:  # last-resort guard so a failed background task isn't silent
        job = db.get(DownloadJob, job_id)
        if job is not None:
            job.status = "error"
            job.error_message = f"Unexpected error: {e}"
            db.commit()
    finally:
        db.close()


@router.post("/download", response_model=DownloadJobOut)
def start_download(body: DownloadRequest, background_tasks: BackgroundTasks, db: DbSession = Depends(get_db)):
    symbol = body.symbol.upper()
    if body.date_to <= body.date_from:
        raise HTTPException(400, "date_to must be after date_from")
    cfg = sessions_service.get_or_create_symbol_config(db, symbol)
    if body.pipet_scale is None and symbol not in dukascopy.supported_symbols():
        raise HTTPException(
            400,
            f"No known Dukascopy price scale for {symbol!r}. Supported: "
            f"{', '.join(dukascopy.supported_symbols())}. Pass pipet_scale to use another symbol.",
        )
    hours_total = dukascopy.count_hours(body.date_from, body.date_to)
    job = DownloadJob(
        symbol=symbol,
        date_from=body.date_from,
        date_to=body.date_to,
        status="pending",
        hours_total=hours_total,
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    background_tasks.add_task(
        _run_download_job, job.id, symbol, body.date_from, body.date_to, cfg.point_size, body.pipet_scale
    )
    return _job_to_out(job)


@router.get("/download", response_model=list[DownloadJobOut])
def list_download_jobs(db: DbSession = Depends(get_db)):
    jobs = db.execute(select(DownloadJob).order_by(DownloadJob.created_at.desc()).limit(20)).scalars().all()
    return [_job_to_out(j) for j in jobs]


@router.get("/download/{job_id}", response_model=DownloadJobOut)
def get_download_job(job_id: str, db: DbSession = Depends(get_db)):
    job = db.get(DownloadJob, job_id)
    if job is None:
        raise HTTPException(404, "Download job not found")
    return _job_to_out(job)

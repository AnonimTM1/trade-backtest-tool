from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session as DbSession

from app.api import sessions_service
from app.api.schemas import SymbolConfigOut, SymbolConfigUpdate
from app.data import parquet_store, resample
from app.db.database import get_db
from app.db.models import SymbolConfig

router = APIRouter(prefix="/api/symbols", tags=["symbols"])


@router.get("", response_model=list[SymbolConfigOut])
def list_symbols(db: DbSession = Depends(get_db)):
    names = set(parquet_store.list_symbols())
    for cfg in db.query(SymbolConfig).all():
        names.add(cfg.name)
    out = []
    for name in sorted(names):
        cfg = sessions_service.get_or_create_symbol_config(db, name)
        m1 = parquet_store.load_m1(name)
        out.append(
            SymbolConfigOut(
                name=cfg.name,
                point_size=cfg.point_size,
                contract_size=cfg.contract_size,
                default_spread_points=cfg.default_spread_points,
                timezone=cfg.timezone,
                has_data=not m1.empty,
                first_bar=m1.index[0].to_pydatetime() if not m1.empty else None,
                last_bar=m1.index[-1].to_pydatetime() if not m1.empty else None,
            )
        )
    return out


@router.put("/{symbol}", response_model=SymbolConfigOut)
def update_symbol_config(symbol: str, body: SymbolConfigUpdate, db: DbSession = Depends(get_db)):
    cfg = sessions_service.get_or_create_symbol_config(db, symbol)
    if body.point_size is not None:
        cfg.point_size = body.point_size
    if body.contract_size is not None:
        cfg.contract_size = body.contract_size
    if body.default_spread_points is not None:
        cfg.default_spread_points = body.default_spread_points
    if body.timezone is not None:
        cfg.timezone = body.timezone
    db.commit()
    db.refresh(cfg)
    resample.invalidate_cache(symbol)
    m1 = parquet_store.load_m1(symbol)
    return SymbolConfigOut(
        name=cfg.name,
        point_size=cfg.point_size,
        contract_size=cfg.contract_size,
        default_spread_points=cfg.default_spread_points,
        timezone=cfg.timezone,
        has_data=not m1.empty,
        first_bar=m1.index[0].to_pydatetime() if not m1.empty else None,
        last_bar=m1.index[-1].to_pydatetime() if not m1.empty else None,
    )


@router.get("/{symbol}/bars")
def get_symbol_bars(
    symbol: str,
    tf: str = Query("M1"),
    limit: int = Query(500, le=5000),
    before: int | None = Query(None, description="unix ms; return bars strictly before this timestamp"),
    db: DbSession = Depends(get_db),
):
    cfg = sessions_service.get_or_create_symbol_config(db, symbol)
    before_ts = None
    if before is not None:
        import pandas as pd

        before_ts = pd.Timestamp(before, unit="ms")
    df = resample.get_bars_upto_cursor(symbol, tf, cursor=None, tz=cfg.timezone, before=before_ts, limit=limit)
    return {"symbol": symbol.upper(), "tf": tf, "candles": sessions_service.df_to_candles(df)}

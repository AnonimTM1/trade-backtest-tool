from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.api.schemas import DrawingIn, DrawingOut
from app.db.database import get_db
from app.db.models import Drawing

router = APIRouter(prefix="/api/symbols", tags=["drawings"])


def _row_to_out(row: Drawing) -> DrawingOut:
    return DrawingOut(
        id=row.id,
        symbol=row.symbol,
        overlay_name=row.overlay_name,
        points=json.loads(row.points),
        styles=json.loads(row.styles) if row.styles else None,
        lock=row.lock,
        visible=row.visible,
        group_id=row.group_id,
        extend_data=json.loads(row.extend_data) if row.extend_data else None,
    )


@router.get("/{symbol}/drawings", response_model=list[DrawingOut])
def list_drawings(symbol: str, db: DbSession = Depends(get_db)):
    rows = db.execute(select(Drawing).where(Drawing.symbol == symbol.upper())).scalars().all()
    return [_row_to_out(r) for r in rows]


@router.post("/{symbol}/drawings", response_model=DrawingOut)
def upsert_drawing(symbol: str, body: DrawingIn, db: DbSession = Depends(get_db)):
    symbol = symbol.upper()
    row = None
    if body.id:
        row = db.get(Drawing, body.id)
    if row is None:
        row = Drawing(symbol=symbol) if not body.id else Drawing(id=body.id, symbol=symbol)
        db.add(row)
    row.symbol = symbol
    row.overlay_name = body.overlay_name
    row.points = json.dumps(body.points)
    row.styles = json.dumps(body.styles) if body.styles is not None else None
    row.lock = body.lock
    row.visible = body.visible
    row.group_id = body.group_id
    row.extend_data = json.dumps(body.extend_data) if body.extend_data is not None else None
    db.commit()
    db.refresh(row)
    return _row_to_out(row)


@router.delete("/{symbol}/drawings/{drawing_id}")
def delete_drawing(symbol: str, drawing_id: str, db: DbSession = Depends(get_db)):
    row = db.get(Drawing, drawing_id)
    if row is None or row.symbol != symbol.upper():
        raise HTTPException(404, "Drawing not found")
    db.delete(row)
    db.commit()
    return {"ok": True}


@router.delete("/{symbol}/drawings")
def delete_all_drawings(symbol: str, db: DbSession = Depends(get_db)):
    db.query(Drawing).filter(Drawing.symbol == symbol.upper()).delete()
    db.commit()
    return {"ok": True}

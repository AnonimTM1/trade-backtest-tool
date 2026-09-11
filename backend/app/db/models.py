import uuid
from datetime import datetime, timezone

from sqlalchemy import String, Float, Integer, DateTime, Boolean, ForeignKey, JSON, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.database import Base


def _uuid() -> str:
    return uuid.uuid4().hex


def _now() -> datetime:
    return datetime.now(timezone.utc)


class SymbolConfig(Base):
    __tablename__ = "symbol_configs"

    name: Mapped[str] = mapped_column(String, primary_key=True)
    point_size: Mapped[float] = mapped_column(Float, default=0.01)
    contract_size: Mapped[float] = mapped_column(Float, default=100.0)
    default_spread_points: Mapped[float] = mapped_column(Float, default=20.0)
    timezone: Mapped[str] = mapped_column(String, default="UTC")


class ReplaySession(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String, default="Session")
    symbol: Mapped[str] = mapped_column(String, index=True)
    start_time: Mapped[datetime] = mapped_column(DateTime)
    cursor_time: Mapped[datetime] = mapped_column(DateTime)
    starting_balance: Mapped[float] = mapped_column(Float, default=10000.0)
    balance: Mapped[float] = mapped_column(Float, default=10000.0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)


class Position(Base):
    __tablename__ = "positions"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    session_id: Mapped[str] = mapped_column(String, ForeignKey("sessions.id"), index=True)
    symbol: Mapped[str] = mapped_column(String)
    side: Mapped[str] = mapped_column(String)  # buy | sell
    lots: Mapped[float] = mapped_column(Float)
    open_price: Mapped[float] = mapped_column(Float)
    open_time: Mapped[datetime] = mapped_column(DateTime)
    sl: Mapped[float | None] = mapped_column(Float, nullable=True)
    tp: Mapped[float | None] = mapped_column(Float, nullable=True)
    contract_size: Mapped[float] = mapped_column(Float)
    point_size: Mapped[float] = mapped_column(Float)
    status: Mapped[str] = mapped_column(String, default="open")  # open | closed


class Trade(Base):
    __tablename__ = "trades"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    session_id: Mapped[str] = mapped_column(String, ForeignKey("sessions.id"), index=True)
    position_id: Mapped[str] = mapped_column(String)
    symbol: Mapped[str] = mapped_column(String)
    side: Mapped[str] = mapped_column(String)
    lots: Mapped[float] = mapped_column(Float)
    open_price: Mapped[float] = mapped_column(Float)
    close_price: Mapped[float] = mapped_column(Float)
    open_time: Mapped[datetime] = mapped_column(DateTime)
    close_time: Mapped[datetime] = mapped_column(DateTime)
    sl: Mapped[float | None] = mapped_column(Float, nullable=True)
    tp: Mapped[float | None] = mapped_column(Float, nullable=True)
    pnl: Mapped[float] = mapped_column(Float)
    close_reason: Mapped[str] = mapped_column(String)  # manual | sl | tp
    contract_size: Mapped[float] = mapped_column(Float, default=100.0)


class DownloadJob(Base):
    __tablename__ = "download_jobs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    symbol: Mapped[str] = mapped_column(String, index=True)
    date_from: Mapped[datetime] = mapped_column(DateTime)
    date_to: Mapped[datetime] = mapped_column(DateTime)
    status: Mapped[str] = mapped_column(String, default="pending")  # pending|running|done|error
    hours_total: Mapped[int] = mapped_column(Integer, default=0)
    hours_done: Mapped[int] = mapped_column(Integer, default=0)
    rows_imported: Mapped[int] = mapped_column(Integer, default=0)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)


class Drawing(Base):
    __tablename__ = "drawings"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    symbol: Mapped[str] = mapped_column(String, index=True)
    overlay_name: Mapped[str] = mapped_column(String)
    points: Mapped[str] = mapped_column(Text)  # JSON list of {timestamp, value}
    styles: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON
    lock: Mapped[bool] = mapped_column(Boolean, default=False)
    visible: Mapped[bool] = mapped_column(Boolean, default=True)
    group_id: Mapped[str | None] = mapped_column(String, nullable=True)
    extend_data: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)

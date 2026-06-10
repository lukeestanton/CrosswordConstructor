"""Database layer.

SQLite owned by this Python layer. Two capabilities matter for the rest of the
app and are verified at startup:

* **FTS5** — full-text search over the clue corpus (built into modern SQLite).
* **sqlite-vec** — vector search for embeddings (the pgvector replacement);
  loaded as a runtime extension on every connection.

Schema itself is defined by Alembic migrations + ``models.py`` in later slices;
this module only owns the engine, sessions, and the capability probe.
"""

from __future__ import annotations

import sqlite3
from typing import Iterator

import sqlite_vec
from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import settings


class Base(DeclarativeBase):
    """Declarative base for all ORM models (populated in later slices)."""


def _connect_args(url: str) -> dict:
    # check_same_thread=False is safe + necessary for FastAPI's threadpool.
    return {"check_same_thread": False} if url.startswith("sqlite") else {}


engine: Engine = create_engine(
    settings.database_url,
    connect_args=_connect_args(settings.database_url),
    future=True,
)


@event.listens_for(engine, "connect")
def _on_connect(dbapi_connection, _connection_record) -> None:
    """Load sqlite-vec and apply pragmas on every new connection."""
    if not isinstance(dbapi_connection, sqlite3.Connection):
        return
    dbapi_connection.enable_load_extension(True)
    sqlite_vec.load(dbapi_connection)
    dbapi_connection.enable_load_extension(False)
    cur = dbapi_connection.cursor()
    cur.execute("PRAGMA journal_mode=WAL")   # better concurrent reads
    cur.execute("PRAGMA foreign_keys=ON")
    cur.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)


def get_session() -> Iterator[Session]:
    """FastAPI dependency yielding a scoped session."""
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def db_health() -> dict:
    """Probe the connection and the two capabilities the app relies on.

    Returns a dict suitable for a health endpoint; raises nothing — callers
    decide how to surface a degraded state.
    """
    status: dict = {"connected": False, "fts5": False, "vec": None}
    with engine.connect() as conn:
        conn.execute(text("SELECT 1"))
        status["connected"] = True

        opts = conn.execute(text("PRAGMA compile_options")).scalars().all()
        status["fts5"] = any("ENABLE_FTS5" in o for o in opts)

        vec_version = conn.execute(text("SELECT vec_version()")).scalar()
        status["vec"] = vec_version
    return status

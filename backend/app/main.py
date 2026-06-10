"""FastAPI application entrypoint.

Slice 1 only needs the app to boot and report health (process + database +
capabilities). Real routers (clue search, etc.) arrive in later slices.
"""

from __future__ import annotations

from fastapi import FastAPI

from .config import settings
from .db import db_health

app = FastAPI(title="Crossword Constructor API", version="0.1.0")


@app.get("/health")
def health() -> dict:
    """Liveness: the process is up and configured."""
    return {"status": "ok", "llm_enabled": settings.llm_enabled}


@app.get("/health/db")
def health_db() -> dict:
    """Readiness: database reachable with FTS5 + sqlite-vec available."""
    return db_health()

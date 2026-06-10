"""FastAPI application entrypoint."""

from __future__ import annotations

from fastapi import FastAPI

from .config import settings
from .db import db_health
from .routers import clue_intel, clues, entries, grids, solver, wordlist

app = FastAPI(title="Crossword Constructor API", version="0.1.0")

app.include_router(entries.router)
app.include_router(clues.router)
app.include_router(grids.router)
app.include_router(wordlist.router)
app.include_router(clue_intel.router)
app.include_router(solver.router)


@app.get("/health")
def health() -> dict:
    """Liveness: the process is up and configured."""
    return {"status": "ok", "llm_enabled": settings.llm_enabled}


@app.get("/health/db")
def health_db() -> dict:
    """Readiness: database reachable with FTS5 + sqlite-vec available."""
    return db_health()

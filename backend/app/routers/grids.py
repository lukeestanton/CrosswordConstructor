"""Grid persistence: saved grids and named snapshots.

The payload is opaque editor-state JSON — the editor owns its shape. Writes
use optimistic concurrency: a PUT must carry the ``rev`` it loaded; on
mismatch the server answers 409 with the current rev and the client decides
how to reconcile. Snapshots copy the grid's *stored* payload server-side;
restoring one is a client-local operation (so it lands on the undo stack),
never a server mutation.
"""

from __future__ import annotations

import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_session
from ..models import Grid, GridSnapshot

router = APIRouter(prefix="/api/grids", tags=["grids"])

# NYT grids run 15x15 daily to 21x21 Sunday; 3..25 leaves room to experiment
# without admitting degenerate sizes.
Size = Annotated[int, Field(ge=3, le=25)]


class GridCreate(BaseModel):
    title: str = ""
    width: Size
    height: Size
    payload: str


class GridUpdate(BaseModel):
    title: str
    width: Size
    height: Size
    payload: str
    rev: int


class SnapshotCreate(BaseModel):
    name: str


def _iso(dt: datetime.datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _get_grid_or_404(session: Session, grid_id: int) -> Grid:
    grid = session.get(Grid, grid_id)
    if grid is None:
        raise HTTPException(status_code=404, detail=f"no grid {grid_id}")
    return grid


@router.get("")
def list_grids(session: Session = Depends(get_session)) -> dict:
    rows = session.execute(
        select(Grid).order_by(Grid.updated_at.desc(), Grid.id.desc())
    ).scalars().all()
    return {
        "results": [
            {
                "id": g.id,
                "title": g.title,
                "width": g.width,
                "height": g.height,
                "rev": g.rev,
                "updated_at": _iso(g.updated_at),
            }
            for g in rows
        ]
    }


@router.post("", status_code=201)
def create_grid(body: GridCreate, session: Session = Depends(get_session)) -> dict:
    grid = Grid(
        title=body.title,
        width=body.width,
        height=body.height,
        payload=body.payload,
        rev=0,
    )
    session.add(grid)
    session.commit()
    return {
        "id": grid.id,
        "title": grid.title,
        "width": grid.width,
        "height": grid.height,
        "rev": grid.rev,
        "created_at": _iso(grid.created_at),
        "updated_at": _iso(grid.updated_at),
    }


@router.get("/{grid_id}")
def get_grid(grid_id: int, session: Session = Depends(get_session)) -> dict:
    grid = _get_grid_or_404(session, grid_id)
    return {
        "id": grid.id,
        "title": grid.title,
        "width": grid.width,
        "height": grid.height,
        "payload": grid.payload,
        "rev": grid.rev,
        "created_at": _iso(grid.created_at),
        "updated_at": _iso(grid.updated_at),
    }


@router.put("/{grid_id}")
def update_grid(grid_id: int, body: GridUpdate, session: Session = Depends(get_session)):
    grid = _get_grid_or_404(session, grid_id)
    if body.rev != grid.rev:
        # Top-level current_rev (not nested under detail) so the client can
        # reconcile without parsing an HTTPException envelope.
        return JSONResponse(
            status_code=409,
            content={
                "detail": f"stale rev {body.rev}; grid is at rev {grid.rev}",
                "current_rev": grid.rev,
            },
        )
    grid.title = body.title
    grid.width = body.width
    grid.height = body.height
    grid.payload = body.payload
    grid.rev = body.rev + 1
    grid.updated_at = datetime.datetime.utcnow()
    session.commit()
    return {"rev": grid.rev}


@router.delete("/{grid_id}", status_code=204)
def delete_grid(grid_id: int, session: Session = Depends(get_session)) -> Response:
    grid = _get_grid_or_404(session, grid_id)
    # Explicit snapshot delete: SQLite FK cascade isn't configured in DDL.
    for snap in session.execute(
        select(GridSnapshot).where(GridSnapshot.grid_id == grid.id)
    ).scalars():
        session.delete(snap)
    session.delete(grid)
    session.commit()
    return Response(status_code=204)


@router.post("/{grid_id}/snapshots", status_code=201)
def create_snapshot(
    grid_id: int, body: SnapshotCreate, session: Session = Depends(get_session)
) -> dict:
    grid = _get_grid_or_404(session, grid_id)
    snap = GridSnapshot(grid_id=grid.id, name=body.name, payload=grid.payload)
    session.add(snap)
    session.commit()
    return {"id": snap.id, "name": snap.name, "created_at": _iso(snap.created_at)}


@router.get("/{grid_id}/snapshots")
def list_snapshots(grid_id: int, session: Session = Depends(get_session)) -> dict:
    _get_grid_or_404(session, grid_id)
    rows = session.execute(
        select(GridSnapshot)
        .where(GridSnapshot.grid_id == grid_id)
        .order_by(GridSnapshot.created_at.desc(), GridSnapshot.id.desc())
    ).scalars().all()
    return {
        "results": [
            {"id": s.id, "name": s.name, "created_at": _iso(s.created_at)} for s in rows
        ]
    }


@router.get("/{grid_id}/snapshots/{snapshot_id}")
def get_snapshot(
    grid_id: int, snapshot_id: int, session: Session = Depends(get_session)
) -> dict:
    snap = session.get(GridSnapshot, snapshot_id)
    if snap is None or snap.grid_id != grid_id:
        raise HTTPException(status_code=404, detail=f"no snapshot {snapshot_id} for grid {grid_id}")
    return {
        "id": snap.id,
        "name": snap.name,
        "payload": snap.payload,
        "created_at": _iso(snap.created_at),
    }

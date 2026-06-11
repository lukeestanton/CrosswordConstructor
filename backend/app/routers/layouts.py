"""Quick Start layout library: NYT-mined black-square patterns.

Serves candidate starting layouts for the new-grid Quick Start. With
``lengths``, results are layouts whose across slots can host words of those
lengths (multiset match via the slot-length signature table); without, it is
a browse of the whole library. Ordering here is a popularity pre-filter —
real fillability ranking happens client-side in the wasm fill engine.
"""

from __future__ import annotations

from collections import Counter

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import get_session

router = APIRouter(prefix="/api/layouts", tags=["layouts"])

ALLOWED_SIZES = {15, 21}
MAX_LENGTHS = 8

SORTS = {
    "popular": "l.usage_count DESC, l.id",
    "blocks": "l.block_count ASC, l.usage_count DESC, l.id",
    "words": "l.word_count ASC, l.usage_count DESC, l.id",
}


def _parse_lengths(raw: str | None, width: int) -> list[int]:
    if not raw:
        return []
    try:
        lengths = [int(part) for part in raw.split(",") if part.strip()]
    except ValueError:
        raise HTTPException(status_code=422, detail="lengths must be integers")
    if len(lengths) > MAX_LENGTHS:
        raise HTTPException(status_code=422, detail=f"at most {MAX_LENGTHS} lengths")
    for n in lengths:
        if not 3 <= n <= width:
            raise HTTPException(
                status_code=422, detail=f"length {n} out of range 3..{width}"
            )
    return lengths


@router.get("")
def list_layouts(
    width: int,
    height: int,
    lengths: str | None = None,
    max_word_count: int | None = Query(default=None, ge=1),
    sort: str = "popular",
    limit: int = Query(default=60, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
) -> dict:
    if width != height or width not in ALLOWED_SIZES:
        raise HTTPException(status_code=422, detail="size must be 15x15 or 21x21")
    if sort not in SORTS:
        raise HTTPException(status_code=422, detail=f"sort must be one of {sorted(SORTS)}")
    need = Counter(_parse_lengths(lengths, width))

    where = ["l.width = :w", "l.height = :h"]
    params: dict = {"w": width, "h": height}
    if max_word_count is not None:
        where.append("l.word_count <= :maxwc")
        params["maxwc"] = max_word_count

    if need:
        # Multiset match: one signature row must exist per distinct length,
        # with enough across slots to host all words of that length.
        conditions = []
        for i, (length, count) in enumerate(sorted(need.items())):
            conditions.append(f"(s.length = :len{i} AND s.across_count >= :cnt{i})")
            params[f"len{i}"] = length
            params[f"cnt{i}"] = count
        params["n_conditions"] = len(conditions)
        base = (
            "FROM layouts l JOIN layout_slot_lengths s ON s.layout_id = l.id "
            f"WHERE {' AND '.join(where)} AND ({' OR '.join(conditions)}) "
            "GROUP BY l.id HAVING COUNT(*) = :n_conditions"
        )
        total = session.execute(
            text(f"SELECT COUNT(*) FROM (SELECT l.id {base})"), params
        ).scalar()
        rows = session.execute(
            text(f"SELECT l.* {base} ORDER BY {SORTS[sort]} LIMIT :limit OFFSET :offset"),
            {**params, "limit": limit, "offset": offset},
        ).mappings().all()
    else:
        base = f"FROM layouts l WHERE {' AND '.join(where)}"
        total = session.execute(text(f"SELECT COUNT(*) {base}"), params).scalar()
        rows = session.execute(
            text(f"SELECT l.* {base} ORDER BY {SORTS[sort]} LIMIT :limit OFFSET :offset"),
            {**params, "limit": limit, "offset": offset},
        ).mappings().all()

    return {
        "total": total,
        "results": [
            {
                "id": r["id"],
                "pattern": r["pattern"],
                "width": r["width"],
                "height": r["height"],
                "word_count": r["word_count"],
                "block_count": r["block_count"],
                "max_slot_len": r["max_slot_len"],
                "usage_count": r["usage_count"],
                "last_used": r["last_used"],
            }
            for r in rows
        ],
    }

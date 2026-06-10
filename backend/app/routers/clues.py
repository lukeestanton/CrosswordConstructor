"""Clue search: FTS5 full-text over the corpus."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import get_session

router = APIRouter(prefix="/api/clues", tags=["clues"])


@router.get("/search")
def search_clues(
    q: str = Query(default="", max_length=128),
    limit: int = Query(default=50, le=200),
    session: Session = Depends(get_session),
) -> dict:
    q = q.strip()
    if not q:
        return {"results": []}
    # Quote each term so user punctuation can't break FTS5 query syntax.
    match = " ".join(f'"{term}"' for term in q.replace('"', " ").split())
    rows = session.execute(
        text(
            """
            SELECT c.clue_text, c.answer, p.date, COALESCE(pub.name, pub.pubid)
            FROM clues_fts f
            JOIN clues c ON c.id = f.rowid
            JOIN puzzles p ON p.id = c.puzzle_id
            LEFT JOIN publications pub ON pub.id = p.publication_id
            WHERE clues_fts MATCH :match
            ORDER BY p.date DESC
            LIMIT :limit
            """
        ),
        {"match": match, "limit": limit},
    ).all()
    return {
        "results": [
            {
                "clue_text": r[0],
                "answer": r[1],
                "date": str(r[2]) if r[2] else None,
                "publication": r[3],
            }
            for r in rows
        ]
    }

"""Entry endpoints: the dictionary's headwords."""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import get_session
from ..services.entry_stats import fetch_entry_payload

router = APIRouter(prefix="/api/entries", tags=["entries"])

_PATTERN_RE = re.compile(r"^[A-Z.]+$")


@router.get("")
def search_entries(
    q: str = Query(default="", max_length=32),
    limit: int = Query(default=50, le=200),
    session: Session = Depends(get_session),
) -> dict:
    """Prefix search, or pattern search when ``q`` contains ``.`` wildcards
    (``E..I`` → 4-letter entries matching E_​_I)."""
    q = q.strip().upper()
    if not q:
        return {"results": []}
    if not _PATTERN_RE.match(q):
        q = re.sub(r"[^A-Z.]", "", q)
        if not q:
            return {"results": []}

    if "." in q:
        sql = (
            "SELECT answer, length, appearance_count, last_seen, wordlist_score "
            "FROM entries WHERE length = :len AND answer LIKE :like "
            "ORDER BY appearance_count DESC, answer LIMIT :limit"
        )
        params = {"len": len(q), "like": q.replace(".", "_"), "limit": limit}
    else:
        sql = (
            "SELECT answer, length, appearance_count, last_seen, wordlist_score "
            "FROM entries WHERE answer LIKE :like "
            "ORDER BY appearance_count DESC, answer LIMIT :limit"
        )
        params = {"like": f"{q}%", "limit": limit}

    rows = session.execute(text(sql), params).all()
    return {
        "results": [
            {
                "answer": r[0],
                "length": r[1],
                "appearance_count": r[2],
                "last_seen": str(r[3]) if r[3] else None,
                "wordlist_score": r[4],
            }
            for r in rows
        ]
    }


@router.get("/{word}")
def get_entry(word: str, session: Session = Depends(get_session)) -> dict:
    normalized = re.sub(r"[^A-Z]", "", word.upper())
    if not normalized:
        raise HTTPException(status_code=404, detail="not a word")
    payload = fetch_entry_payload(session, normalized)
    if payload is None:
        raise HTTPException(status_code=404, detail=f"no entry for {normalized}")
    return payload

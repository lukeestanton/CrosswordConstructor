"""Clue intelligence for the editor: corpus freshness + per-slot history.

The batch endpoint feeds the candidates panel's freshness column — one IN
query for up to a page of candidate words. The per-answer endpoint feeds the
slot history panel (dated senses, like the entry page but trimmed).
"""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import get_session
from ..services.entry_stats import build_senses, _to_date, _iso

router = APIRouter(prefix="/api/clue-intel", tags=["clue-intel"])

MAX_BATCH = 200


class EntriesBatch(BaseModel):
    answers: list[str] = Field(max_length=MAX_BATCH)


@router.post("/entries")
def batch_entry_stats(
    body: EntriesBatch, session: Session = Depends(get_session)
) -> dict:
    answers = list(
        {re.sub(r"[^A-Z]", "", a.upper()) for a in body.answers if a.strip()}
    )
    if not answers:
        return {"entries": {}}
    placeholders = ", ".join(f":a{i}" for i in range(len(answers)))
    params = {f"a{i}": a for i, a in enumerate(answers)}
    rows = session.execute(
        text(
            f"SELECT answer, appearance_count, first_seen, last_seen "
            f"FROM entries WHERE answer IN ({placeholders})"
        ),
        params,
    ).all()
    found = {
        r[0]: {
            "appearance_count": r[1],
            "first_seen": _iso(r[2]),
            "last_seen": _iso(r[3]),
        }
        for r in rows
    }
    # Words absent from entries have genuinely never appeared (count 0).
    return {
        "entries": {
            a: found.get(
                a, {"appearance_count": 0, "first_seen": None, "last_seen": None}
            )
            for a in answers
        }
    }


@router.get("/{answer}")
def entry_intel(answer: str, session: Session = Depends(get_session)) -> dict:
    normalized = re.sub(r"[^A-Z]", "", answer.upper())
    if not normalized:
        raise HTTPException(status_code=404, detail="not a word")

    stats = session.execute(
        text(
            "SELECT appearance_count, first_seen, last_seen, wordlist_score "
            "FROM entries WHERE answer = :a"
        ),
        {"a": normalized},
    ).one_or_none()

    clue_rows = session.execute(
        text(
            """
            SELECT c.clue_text, p.date, COALESCE(pub.name, pub.pubid)
            FROM clues c
            JOIN puzzles p ON p.id = c.puzzle_id
            LEFT JOIN publications pub ON pub.id = p.publication_id
            WHERE c.answer = :a
            """
        ),
        {"a": normalized},
    ).all()

    senses = build_senses([(r[0], _to_date(r[1]), r[2]) for r in clue_rows])
    return {
        "answer": normalized,
        "appearance_count": stats[0] if stats else 0,
        "first_seen": _iso(stats[1]) if stats else None,
        "last_seen": _iso(stats[2]) if stats else None,
        "wordlist_score": stats[3] if stats else None,
        "senses": [
            {
                "display": s.display,
                "count": s.count,
                "share": round(s.share, 4),
                "citations": [
                    {
                        "date": _iso(c.date),
                        "publication": c.publication,
                        "clue_text": c.clue_text,
                    }
                    for c in s.citations[:3]
                ],
            }
            for s in senses[:6]
        ],
    }

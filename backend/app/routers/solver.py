"""Solver companion API: sync, archive browser, digests, recommendations.

A "date the app knows about" is the union of solves, poll_results, and
rex_posts — the archive shows a date as soon as any source has it, with the
other sources nested as null until they sync.

Error hygiene: per-target sync failures are reported as a generic message plus
the exception class name only. The NYT cookie can never appear here — see
``services/nyt.py`` for where (and only where) it is used.
"""

from __future__ import annotations

import datetime
import json

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_session
from ..services.digest import get_or_create_digest
from ..services.nyt import make_nyt_client, sync_incremental
from ..services.polls import sync_polls
from ..services.rexparker import sync_rex

router = APIRouter(prefix="/api/solver", tags=["solver"])

ALL_TARGETS = ("nyt", "polls", "rex")

# Every known puzzle date, from whichever source mentioned it first.
_DATES_CTE = """
WITH dates(puzzle_date) AS (
    SELECT puzzle_date FROM solves
    UNION SELECT puzzle_date FROM poll_results
    UNION SELECT puzzle_date FROM rex_posts
)
"""

_ARCHIVE_SELECT = """
SELECT d.puzzle_date,
       s.id AS solve_id, s.solved, s.solve_time_secs, s.raw,
       p.id AS poll_id, p.avg_rating, p.sample_size,
       r.id AS rex_id, r.relative_difficulty, r.title AS rex_title, r.url AS rex_url,
       EXISTS(SELECT 1 FROM digests g WHERE g.puzzle_date = d.puzzle_date) AS has_digest
FROM dates d
LEFT JOIN solves s ON s.puzzle_date = d.puzzle_date
LEFT JOIN poll_results p ON p.puzzle_date = d.puzzle_date
LEFT JOIN rex_posts r ON r.puzzle_date = d.puzzle_date
"""


class SyncRequest(BaseModel):
    targets: list[str] | None = None


@router.post("/sync")
def sync(body: SyncRequest | None = None, session: Session = Depends(get_session)) -> dict:
    targets = body.targets if body and body.targets else list(ALL_TARGETS)
    out: dict = {}
    for target in targets:
        if target not in ALL_TARGETS:
            out[target] = {"error": f"unknown target {target!r}"}
            continue
        try:
            if target == "nyt":
                if not settings.times_cookie:
                    out[target] = {"skipped": "not configured"}
                    continue
                with make_nyt_client(settings.times_cookie) as client:
                    out[target] = {"synced": sync_incremental(session, client)}
            elif target == "polls":
                if not settings.poll_archive_url:
                    out[target] = {"skipped": "not configured"}
                    continue
                with httpx.Client(timeout=30.0) as client:
                    out[target] = {
                        "synced": sync_polls(session, client, settings.poll_archive_url)
                    }
            else:  # rex — public feed, no configuration needed
                with httpx.Client(timeout=30.0, follow_redirects=True) as client:
                    out[target] = {"synced": sync_rex(session, client)}
        except Exception as exc:
            # Generic message + class name only; never the cookie or the URL.
            out[target] = {"error": f"sync failed ({type(exc).__name__})"}
    return out


def _record(row) -> dict:
    raw = {}
    if row.raw:
        try:
            raw = json.loads(row.raw)
        except ValueError:
            raw = {}
    return {
        "date": str(row.puzzle_date),
        "solved": bool(row.solved) if row.solve_id is not None else None,
        "solve_time_secs": row.solve_time_secs,
        "star": raw.get("star") if isinstance(raw, dict) else None,
        "poll": (
            {"avg_rating": row.avg_rating, "sample_size": row.sample_size}
            if row.poll_id is not None
            else None
        ),
        "rex": (
            {
                "relative_difficulty": row.relative_difficulty,
                "title": row.rex_title,
                "url": row.rex_url,
            }
            if row.rex_id is not None
            else None
        ),
        "has_digest": bool(row.has_digest),
    }


@router.get("/archive")
def archive(
    from_date: datetime.date | None = None,
    to_date: datetime.date | None = None,
    limit: int = 100,
    session: Session = Depends(get_session),
) -> dict:
    rows = session.execute(
        text(
            _DATES_CTE
            + _ARCHIVE_SELECT
            + """
            WHERE (:from_date IS NULL OR d.puzzle_date >= :from_date)
              AND (:to_date IS NULL OR d.puzzle_date <= :to_date)
            ORDER BY d.puzzle_date DESC
            LIMIT :limit
            """
        ),
        {
            "from_date": from_date.isoformat() if from_date else None,
            "to_date": to_date.isoformat() if to_date else None,
            "limit": limit,
        },
    ).all()
    return {"results": [_record(r) for r in rows]}


@router.get("/archive/{puzzle_date}")
def archive_detail(
    puzzle_date: datetime.date, session: Session = Depends(get_session)
) -> dict:
    row = session.execute(
        text(
            _DATES_CTE
            + """
            SELECT d.puzzle_date,
                   s.id AS solve_id, s.solved, s.solve_time_secs, s.raw,
                   p.id AS poll_id, p.avg_rating, p.sample_size,
                   p.distribution AS poll_distribution,
                   r.id AS rex_id, r.relative_difficulty,
                   r.title AS rex_title, r.url AS rex_url,
                   g.id IS NOT NULL AS has_digest, g.content AS digest_content
            FROM dates d
            LEFT JOIN solves s ON s.puzzle_date = d.puzzle_date
            LEFT JOIN poll_results p ON p.puzzle_date = d.puzzle_date
            LEFT JOIN rex_posts r ON r.puzzle_date = d.puzzle_date
            LEFT JOIN digests g ON g.puzzle_date = d.puzzle_date
            WHERE d.puzzle_date = :d
            """
        ),
        {"d": puzzle_date.isoformat()},
    ).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail=f"nothing known for {puzzle_date}")
    record = _record(row)
    record["digest"] = row.digest_content  # cached content only; never generated here
    if record["poll"] is not None and row.poll_distribution:
        try:
            record["poll"]["distribution"] = json.loads(row.poll_distribution)
        except ValueError:
            record["poll"]["distribution"] = None
    return record


@router.get("/digest/{puzzle_date}")
def digest(puzzle_date: datetime.date, session: Session = Depends(get_session)) -> dict:
    return get_or_create_digest(session, puzzle_date)


@router.get("/recommendations")
def recommendations(
    limit: int = 10, session: Session = Depends(get_session)
) -> dict:
    """Unsolved dates ranked by poll rating (nulls last), then recency."""
    rows = session.execute(
        text(
            _DATES_CTE
            + """
            SELECT d.puzzle_date,
                   p.avg_rating, p.sample_size,
                   r.relative_difficulty
            FROM dates d
            LEFT JOIN solves s ON s.puzzle_date = d.puzzle_date
            LEFT JOIN poll_results p ON p.puzzle_date = d.puzzle_date
            LEFT JOIN rex_posts r ON r.puzzle_date = d.puzzle_date
            WHERE s.id IS NULL OR s.solved = 0
            ORDER BY p.avg_rating DESC NULLS LAST, d.puzzle_date DESC
            LIMIT :limit
            """
        ),
        {"limit": limit},
    ).all()

    results = []
    for row in rows:
        date = datetime.date.fromisoformat(str(row.puzzle_date))
        reasons = []
        if row.avg_rating is not None:
            n = f" (n={row.sample_size})" if row.sample_size else ""
            reasons.append(f"poll {row.avg_rating:.1f}/5{n}")
        reasons.append(date.strftime("%A"))
        if row.relative_difficulty:
            reasons.append(f"Rex: {row.relative_difficulty}")
        results.append({"date": date.isoformat(), "reasons": reasons})
    return {"results": results}

"""Community poll archive sync.

The archive endpoint returns a JSON list of per-date rating rows. Rows are
hand-entered upstream, so parsing is defensive: unparseable rows are skipped,
missing keys tolerated, extra keys ignored. Upserts key on
(puzzle_date, source) so a re-run is idempotent and a future second source
slots in without schema work.
"""

from __future__ import annotations

import datetime
import json
import logging

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import PollResult

logger = logging.getLogger(__name__)

SOURCE = "community-poll"


def sync_polls(session: Session, client: httpx.Client, url: str) -> int:
    """GET the poll archive and upsert rows. Returns the number upserted."""
    resp = client.get(url)
    resp.raise_for_status()
    rows = resp.json()
    if not isinstance(rows, list):
        raise ValueError("poll archive did not return a JSON list")

    synced = 0
    for raw in rows:
        if not isinstance(raw, dict):
            continue
        try:
            puzzle_date = datetime.date.fromisoformat(str(raw.get("date")))
        except (TypeError, ValueError):
            continue  # unparseable row — skip, don't fail the run

        avg = raw.get("average")
        avg_rating = float(avg) if isinstance(avg, (int, float)) else None
        votes = raw.get("votes")
        sample_size = votes if isinstance(votes, int) and not isinstance(votes, bool) else None
        dist = raw.get("distribution")
        distribution = json.dumps(dist, sort_keys=True) if isinstance(dist, dict) else None

        row = session.execute(
            select(PollResult).where(
                PollResult.puzzle_date == puzzle_date, PollResult.source == SOURCE
            )
        ).scalar_one_or_none()
        if row is None:
            row = PollResult(puzzle_date=puzzle_date, source=SOURCE)
            session.add(row)
        row.avg_rating = avg_rating
        row.sample_size = sample_size
        row.distribution = distribution
        synced += 1

    session.commit()
    logger.info("poll sync: %d rows upserted", synced)
    return synced

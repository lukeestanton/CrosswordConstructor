"""Community poll archive sync.

The archive endpoint (the r/crossword poll worker) returns a JSON list of
per-puzzle rows. Each row looks like::

    {"dateString": "06/04/2026", "publishedDate": 1780531200000,
     "pollExists": true, "votes": 492, "averageRating": 3.24,
     "excellent": 41, "good": 201, "average": 128, "poor": 79, "terrible": 43,
     "noVote": 131, "pollURL": "https://reddit.com/...", ...}

Note the field names: the puzzle date is ``dateString`` (MM/DD/YYYY), the
rating is ``averageRating`` (``average`` is the *count* of "average" votes,
not the mean), and the histogram is the five named buckets. Parsing is
defensive: rows without a poll or a parseable date are skipped, missing keys
tolerated, extra keys ignored. Upserts key on (puzzle_date, source) so a
re-run is idempotent and a future second source slots in without schema work.
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

# The five rating buckets, strongest to weakest, as they appear in each row.
_RATING_BUCKETS = ("excellent", "good", "average", "poor", "terrible")


def _is_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _parse_poll_date(raw: dict) -> datetime.date | None:
    """Prefer the human ``dateString`` (MM/DD/YYYY); fall back to epoch-ms."""
    ds = raw.get("dateString")
    if isinstance(ds, str):
        try:
            return datetime.datetime.strptime(ds, "%m/%d/%Y").date()
        except ValueError:
            pass
    pub = raw.get("publishedDate")
    if _is_number(pub):
        try:
            return datetime.datetime.fromtimestamp(
                pub / 1000, tz=datetime.timezone.utc
            ).date()
        except (OverflowError, OSError, ValueError):
            return None
    return None


def sync_polls(session: Session, client: httpx.Client, url: str) -> int:
    """GET the poll archive and upsert rows that have a poll. Returns the count."""
    resp = client.get(url)
    resp.raise_for_status()
    rows = resp.json()
    if not isinstance(rows, list):
        raise ValueError("poll archive did not return a JSON list")

    synced = 0
    for raw in rows:
        if not isinstance(raw, dict):
            continue
        if not raw.get("pollExists"):
            continue  # dates without a community poll carry no ratings — skip
        puzzle_date = _parse_poll_date(raw)
        if puzzle_date is None:
            continue  # unparseable date — skip, don't fail the run

        avg = raw.get("averageRating")
        avg_rating = float(avg) if _is_number(avg) else None
        votes = raw.get("votes")
        sample_size = votes if isinstance(votes, int) and not isinstance(votes, bool) else None
        buckets = {b: raw[b] for b in _RATING_BUCKETS if _is_number(raw.get(b))}
        distribution = json.dumps(buckets, sort_keys=True) if buckets else None

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

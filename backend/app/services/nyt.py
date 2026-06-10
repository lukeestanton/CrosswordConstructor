"""NYT solve-history sync.

Security contract (see CLAUDE.md):

* The ``NYT-S`` cookie is attached to a client in exactly ONE place —
  :func:`make_nyt_client` — and that client refuses, via a request event
  hook, to send anything to a host that isn't nytimes.com. Sync functions
  only ever request relative paths against the client's ``base_url``.
* The cookie value must never appear in logs or exception text. Failures are
  re-raised as :class:`NytSyncError` carrying only a generic message plus the
  underlying exception's class name; nothing here logs headers.
"""

from __future__ import annotations

import datetime
import json
import logging
import time
from typing import Callable

import httpx
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Solve

logger = logging.getLogger(__name__)

NYT_BASE_URL = "https://www.nytimes.com"
_NYT_HOST_SUFFIX = "nytimes.com"

PUZZLE_LIST_PATH = "/svc/crosswords/v3/puzzles.json"
GAME_PATH = "/svc/crosswords/v6/game/{puzzle_id}.json"

# Scraping etiquette: pause between per-puzzle calls. Injectable for tests.
PER_PUZZLE_DELAY_SECS = 0.5

# Incremental sync with an empty table starts this far back.
EMPTY_BACKFILL_DAYS = 30


class NytSyncError(RuntimeError):
    """Raised on sync failure. Carries only generic text — never the cookie."""


def _refuse_non_nyt_hosts(request: httpx.Request) -> None:
    """Request event hook: abort before the cookie leaves for a foreign host."""
    host = request.url.host or ""
    if host != _NYT_HOST_SUFFIX and not host.endswith("." + _NYT_HOST_SUFFIX):
        raise NytSyncError(
            f"refusing to send a request carrying the NYT cookie to host {host!r}"
        )


def make_nyt_client(
    cookie: str, transport: httpx.BaseTransport | None = None
) -> httpx.Client:
    """The ONLY place the NYT cookie is used. ``transport`` exists for tests."""
    return httpx.Client(
        base_url=NYT_BASE_URL,
        headers={"Cookie": f"NYT-S={cookie}"},
        event_hooks={"request": [_refuse_non_nyt_hosts]},
        timeout=30.0,
        transport=transport,
    )


def _to_date(value) -> datetime.date | None:
    if isinstance(value, datetime.date):
        return value
    try:
        return datetime.date.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None


def _fetch_calcs(client: httpx.Client, puzzle_id: int) -> dict:
    """Per-puzzle game state; tolerate missing/failed responses (no calcs)."""
    try:
        resp = client.get(GAME_PATH.format(puzzle_id=puzzle_id))
        if resp.status_code != 200:
            return {}
        payload = resp.json() or {}
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning(
            "game fetch failed for puzzle %s (%s)", puzzle_id, type(exc).__name__
        )
        return {}
    calcs = payload.get("calcs")
    return calcs if isinstance(calcs, dict) else {}


def sync_solves(
    session: Session,
    client: httpx.Client,
    start: datetime.date,
    end: datetime.date,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    """Fetch the puzzle list for [start, end] and upsert one Solve per date."""
    try:
        resp = client.get(
            PUZZLE_LIST_PATH,
            params={
                "publish_type": "daily",
                "date_start": start.isoformat(),
                "date_end": end.isoformat(),
            },
        )
        resp.raise_for_status()
        results = resp.json().get("results") or []
    except (httpx.HTTPError, ValueError) as exc:
        # Generic message + class name only — never headers, never the cookie.
        raise NytSyncError(
            f"NYT puzzle list fetch failed ({type(exc).__name__})"
        ) from exc

    synced = 0
    for i, entry in enumerate(results):
        if not isinstance(entry, dict):
            continue
        puzzle_date = _to_date(entry.get("print_date"))
        if puzzle_date is None:
            continue
        puzzle_id = entry.get("puzzle_id")

        if i:
            sleep(PER_PUZZLE_DELAY_SECS)
        calcs = _fetch_calcs(client, puzzle_id) if puzzle_id is not None else {}

        solved = bool(calcs.get("solved", entry.get("solved", False)))
        solve_time = calcs.get("secondsSpentSolving")
        if not isinstance(solve_time, int):
            solve_time = None

        row = session.execute(
            select(Solve).where(Solve.puzzle_date == puzzle_date)
        ).scalar_one_or_none()
        if row is None:
            row = Solve(puzzle_date=puzzle_date, day_of_week=puzzle_date.weekday())
            session.add(row)
        row.nyt_puzzle_id = puzzle_id
        row.solved = solved
        row.solve_time_secs = solve_time
        row.day_of_week = puzzle_date.weekday()
        row.raw = json.dumps(entry, sort_keys=True)
        row.synced_at = datetime.datetime.utcnow()
        synced += 1

    session.commit()
    logger.info("nyt sync: %d solves upserted (%s..%s)", synced, start, end)
    return synced


def sync_incremental(
    session: Session,
    client: httpx.Client,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    """Sync from the day after the latest synced date (or 30 days back) to today."""
    latest = _to_date(session.execute(select(func.max(Solve.puzzle_date))).scalar())
    today = datetime.date.today()
    if latest is None:
        start = today - datetime.timedelta(days=EMPTY_BACKFILL_DAYS)
    else:
        start = latest + datetime.timedelta(days=1)
    if start > today:
        return 0
    return sync_solves(session, client, start, today, sleep=sleep)

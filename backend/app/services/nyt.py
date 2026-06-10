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
from typing import Callable, Iterator

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

# The puzzle-list endpoint caps each response at 100 results AND only populates
# per-user fields (solved/star/percent_filled) for sufficiently narrow windows —
# a wide date range silently comes back unenriched. So we always page the list
# in <=90-day windows (a quarter of daily puzzles, comfortably under the cap).
LIST_WINDOW_DAYS = 90

# A wide backfill makes ~130 list calls; a single transient blip shouldn't sink
# the whole walk, so each window is retried with linear backoff before giving up.
LIST_RETRIES = 4

# Commit every this many upserts so a late failure on a long walk loses little —
# the upsert is idempotent, so a re-run resumes cheaply.
COMMIT_EVERY = 100

# Incremental sync with an empty table starts this far back.
EMPTY_BACKFILL_DAYS = 30

# Earliest date the puzzle-list API serves; --full backfills walk back to here.
ARCHIVE_FLOOR = datetime.date(1993, 11, 21)


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


def _fetch_list_window(
    client: httpx.Client,
    window_start: datetime.date,
    window_end: datetime.date,
    sleep: Callable[[float], None],
) -> list:
    """Fetch one list window, retrying transient failures with linear backoff.

    Raises :class:`NytSyncError` only after every retry fails — its message
    carries the failing window and the exception class name, never the cookie.
    """
    last_exc: Exception | None = None
    for attempt in range(LIST_RETRIES):
        if attempt:
            sleep(PER_PUZZLE_DELAY_SECS * (attempt + 1))
        try:
            resp = client.get(
                PUZZLE_LIST_PATH,
                params={
                    "publish_type": "daily",
                    "date_start": window_start.isoformat(),
                    "date_end": window_end.isoformat(),
                },
            )
            resp.raise_for_status()
            return resp.json().get("results") or []
        except (httpx.HTTPError, ValueError) as exc:
            last_exc = exc
            logger.warning(
                "nyt list window %s..%s failed (%s), attempt %d/%d",
                window_start, window_end, type(exc).__name__, attempt + 1, LIST_RETRIES,
            )
    raise NytSyncError(
        f"NYT puzzle list fetch failed for {window_start}..{window_end} "
        f"({type(last_exc).__name__})"
    ) from last_exc


def _iter_list_entries(
    client: httpx.Client,
    start: datetime.date,
    end: datetime.date,
    sleep: Callable[[float], None],
) -> Iterator[dict]:
    """Yield daily-puzzle list entries across [start, end].

    Pages the list endpoint in <=90-day windows, walking backward from ``end``,
    so every response stays under the 100-result cap and carries the per-user
    enrichment (see :data:`LIST_WINDOW_DAYS`). A window that returns nothing —
    e.g. before the archive floor — simply contributes no entries; the walk
    continues to ``start``.
    """
    window_end = end
    first = True
    while window_end >= start:
        window_start = max(start, window_end - datetime.timedelta(days=LIST_WINDOW_DAYS - 1))
        if not first:
            sleep(PER_PUZZLE_DELAY_SECS)
        first = False
        for entry in _fetch_list_window(client, window_start, window_end, sleep):
            if isinstance(entry, dict):
                yield entry
        window_end = window_start - datetime.timedelta(days=1)


def sync_solves(
    session: Session,
    client: httpx.Client,
    start: datetime.date,
    end: datetime.date,
    sleep: Callable[[float], None] = time.sleep,
    fetch_times: bool = True,
) -> int:
    """Upsert the solve history for [start, end], paging the list as needed.

    ``solved``/``star``/``percent_filled`` come from the (cheap, paged) list.
    Only *engaged* puzzles — solved or in progress — are recorded, so the table
    stays a solve history rather than a catalog of every daily ever published.
    For each engaged puzzle, unless ``fetch_times`` is False, one game-state
    call supplies the solve time (and authoritative solved flag).
    """
    synced = 0
    game_calls = 0
    for entry in _iter_list_entries(client, start, end, sleep):
        puzzle_date = _to_date(entry.get("print_date"))
        if puzzle_date is None:
            continue
        solved = bool(entry.get("solved"))
        pct = entry.get("percent_filled")
        in_progress = isinstance(pct, int) and not isinstance(pct, bool) and pct > 0
        if not solved and not in_progress:
            continue  # untouched puzzle — not part of the solve history

        puzzle_id = entry.get("puzzle_id")
        solve_time = None
        if fetch_times and puzzle_id is not None:
            if game_calls:
                sleep(PER_PUZZLE_DELAY_SECS)
            game_calls += 1
            calcs = _fetch_calcs(client, puzzle_id)
            st = calcs.get("secondsSpentSolving")
            solve_time = st if isinstance(st, int) and not isinstance(st, bool) else None
            if "solved" in calcs:  # game state is authoritative when present
                solved = bool(calcs.get("solved"))

        row = session.execute(
            select(Solve).where(Solve.puzzle_date == puzzle_date)
        ).scalar_one_or_none()
        if row is None:
            row = Solve(puzzle_date=puzzle_date, day_of_week=puzzle_date.weekday())
            session.add(row)
        row.nyt_puzzle_id = puzzle_id
        row.solved = solved
        if fetch_times:  # a --no-times pass must not wipe previously-fetched times
            row.solve_time_secs = solve_time
        row.day_of_week = puzzle_date.weekday()
        row.raw = json.dumps(entry, sort_keys=True)
        row.synced_at = datetime.datetime.utcnow()
        synced += 1
        if synced % COMMIT_EVERY == 0:  # save progress on long backfills
            session.commit()

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

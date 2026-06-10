"""Rex Parker blog sync via the Blogspot Atom feed (RSS-etiquette compliant).

The puzzle date lives in the post *title* ("Hard-soled sandal / SUN 6-7-26 /
…"), not in feed metadata, so it's extracted by regex; entries with no
parseable date (housekeeping posts) are skipped. Conditional GET state
(ETag / Last-Modified) is stored in the existing ``ingest_state`` table so a
nightly job that hits an unchanged feed costs one 304 and zero parsing.

Parsed with xml.etree — no new dependencies for one well-formed Atom feed.
"""

from __future__ import annotations

import datetime
import logging
import re
import xml.etree.ElementTree as ET

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import IngestState, RexPost

logger = logging.getLogger(__name__)

DEFAULT_FEED_URL = "https://rexwordpuzzle.blogspot.com/feeds/posts/default"
ATOM = "{http://www.w3.org/2005/Atom}"

ETAG_KEY = "rex_etag"
LAST_MODIFIED_KEY = "rex_last_modified"

# "SUN 6-7-26" / "SAT 12-25-21" / "MON 6/8/26" — M-D-YY (or M/D/YY, or 4-digit
# year), with the day-name optional.
_DAYNAME = r"(?:MON|TUES?|WED|THURS?|FRI|SAT|SUN)"
_DATE_RE = re.compile(
    rf"(?:\b{_DAYNAME}\b\.?,?\s+)?(\d{{1,2}})[-/](\d{{1,2}})[-/](\d{{2,4}})"
)
_DIFFICULTY_RE = re.compile(r"Relative difficulty:\s*([^<\n.]+)")


def parse_post_date(title: str) -> datetime.date | None:
    m = _DATE_RE.search(title)
    if not m:
        return None
    month, day, year = (int(g) for g in m.groups())
    if year < 100:
        year += 2000
    try:
        return datetime.date(year, month, day)
    except ValueError:
        return None


def _parse_published(text: str | None) -> datetime.datetime | None:
    if not text:
        return None
    try:
        dt = datetime.datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(datetime.timezone.utc).replace(tzinfo=None)
    return dt


def _state_get(session: Session, key: str) -> str | None:
    row = session.get(IngestState, key)
    return row.value if row else None


def _state_set(session: Session, key: str, value: str | None) -> None:
    row = session.get(IngestState, key)
    if value is None:
        if row is not None:
            session.delete(row)
    elif row is None:
        session.add(IngestState(key=key, value=value))
    else:
        row.value = value


def sync_rex(
    session: Session, client: httpx.Client, feed_url: str = DEFAULT_FEED_URL
) -> int:
    """Fetch the Atom feed and upsert one RexPost per dated entry.

    Returns the number of entries upserted; 0 on a 304 Not Modified replay.
    """
    headers: dict[str, str] = {}
    etag = _state_get(session, ETAG_KEY)
    last_modified = _state_get(session, LAST_MODIFIED_KEY)
    if etag:
        headers["If-None-Match"] = etag
    if last_modified:
        headers["If-Modified-Since"] = last_modified

    resp = client.get(feed_url, headers=headers)
    if resp.status_code == 304:
        logger.info("rex sync: feed not modified")
        return 0
    resp.raise_for_status()

    root = ET.fromstring(resp.text)
    synced = 0
    for entry in root.findall(f"{ATOM}entry"):
        title = (entry.findtext(f"{ATOM}title") or "").strip()
        puzzle_date = parse_post_date(title)
        if puzzle_date is None:
            continue  # housekeeping post, anniversary note, etc.

        url = next(
            (
                link.get("href")
                for link in entry.findall(f"{ATOM}link")
                if link.get("rel") == "alternate" and link.get("href")
            ),
            None,
        )
        if not url:
            continue

        content = (
            entry.findtext(f"{ATOM}content") or entry.findtext(f"{ATOM}summary") or ""
        )
        m = _DIFFICULTY_RE.search(content)
        difficulty = m.group(1).strip() if m else None

        row = session.execute(
            select(RexPost).where(RexPost.puzzle_date == puzzle_date)
        ).scalar_one_or_none()
        if row is None:
            row = RexPost(puzzle_date=puzzle_date, title=title, url=url)
            session.add(row)
        row.title = title
        row.url = url
        row.published_at = _parse_published(entry.findtext(f"{ATOM}published"))
        row.relative_difficulty = difficulty
        row.summary_raw = content or None
        synced += 1

    _state_set(session, ETAG_KEY, resp.headers.get("ETag"))
    _state_set(session, LAST_MODIFIED_KEY, resp.headers.get("Last-Modified"))
    session.commit()
    logger.info("rex sync: %d posts upserted", synced)
    return synced

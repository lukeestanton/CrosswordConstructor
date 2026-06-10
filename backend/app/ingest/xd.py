"""xd corpus ingestion.

Parses ``.xd`` puzzle files (the century-arcade interchange format) streamed
directly out of ``xd-puzzles.zip`` — no extraction to disk — joined against
``xd-metadata.zip``'s ``puzzles.tsv`` for canonical dates and metadata. The
``.xd`` files are the source of truth because only they carry the clue→exact
date linkage the entry page's dated citations need; ``clues.tsv`` is
year-granular and derived.

Built to survive a 280MB real-world run it cannot rehearse here (the corpus
host is unreachable from CI/sandboxes): tolerant per-file parsing that skips
and reports rather than aborts, 10k-row executemany batches, idempotent by
``xdid``, resumable via ``ingest_state``, and a final stats + FTS rebuild
phase that is itself re-runnable.
"""

from __future__ import annotations

import datetime
import io
import re
import zipfile
from dataclasses import dataclass, field
from typing import Callable, Iterator

from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine

BATCH_SIZE = 10_000

# xdid like "nyt1993-02-07" → pubid "nyt", date 1993-02-07.
_XDID_RE = re.compile(r"^([a-z][a-z0-9]*?)(\d{4}-\d{2}-\d{2})?$")
_DATE_RE = re.compile(r"(\d{4})-(\d{2})-(\d{2})")
# Clue line: "A1. Some clue text ~ ANSWER" (answer may be absent in rare files).
_CLUE_RE = re.compile(r"^([AD])(\d+)\.\s*(.*?)(?:\s*~\s*([^~]*))?$")

# Friendly names for the publications that dominate the corpus; everything
# else renders by pubid until metadata supplies a name.
KNOWN_PUBLICATIONS = {
    "nyt": "The New York Times",
    "lat": "Los Angeles Times",
    "wsj": "The Wall Street Journal",
    "wapo": "The Washington Post",
    "usa": "USA Today",
    "nyk": "The New Yorker",
    "uni": "Universal",
    "atc": "Across the Centuries",
    "cs": "CrosSynergy",
}


@dataclass
class ParsedPuzzle:
    xdid: str
    date: datetime.date | None = None
    title: str | None = None
    author: str | None = None
    editor: str | None = None
    copyright: str | None = None
    width: int | None = None
    height: int | None = None
    # (direction 'A'/'D', number, clue_text, normalized_answer)
    clues: list[tuple[str, int | None, str, str]] = field(default_factory=list)


def normalize_answer(raw: str) -> str:
    """Bare A–Z uppercase: strips spaces, punctuation, accents-as-given."""
    return re.sub(r"[^A-Z]", "", raw.upper())


def xdid_from_member(name: str) -> str:
    """Zip member path → xdid: 'crosswords/nyt/1993/nyt1993-02-07.xd' → 'nyt1993-02-07'."""
    base = name.rsplit("/", 1)[-1]
    return base[:-3] if base.endswith(".xd") else base


def parse_date(value: str | None) -> datetime.date | None:
    if not value:
        return None
    m = _DATE_RE.search(value)
    if not m:
        return None
    try:
        return datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None


def parse_xd(text_content: str, xdid: str) -> ParsedPuzzle:
    """Parse one .xd file. Sections are separated by blank lines:
    headers, grid, across clues, down clues. Tolerant of extra blank lines
    and missing sections — returns whatever it could read."""
    puzzle = ParsedPuzzle(xdid=xdid)
    sections: list[list[str]] = [[]]
    for line in text_content.splitlines():
        if line.strip() == "":
            if sections[-1]:
                sections.append([])
        else:
            sections[-1].append(line.rstrip("\n"))
    if sections and not sections[-1]:
        sections.pop()
    if not sections:
        return puzzle

    # Headers: "Key: Value" lines in the first section.
    header_lines = sections[0]
    headers: dict[str, str] = {}
    is_header_section = all(":" in line for line in header_lines)
    if is_header_section:
        for line in header_lines:
            key, _, value = line.partition(":")
            headers[key.strip().lower()] = value.strip()
    puzzle.title = headers.get("title")
    puzzle.author = headers.get("author")
    puzzle.editor = headers.get("editor")
    puzzle.copyright = headers.get("copyright")
    puzzle.date = parse_date(headers.get("date")) or parse_date(xdid)

    # Grid: the first subsequent section whose lines are uniform-width cell rows.
    body = sections[1:] if is_header_section else sections
    grid_idx = None
    for i, sec in enumerate(body):
        if sec and all(re.fullmatch(r"[A-Za-z0-9#_.]+", line) for line in sec):
            if len({len(line) for line in sec}) == 1 and len(sec) > 1:
                grid_idx = i
                puzzle.height = len(sec)
                puzzle.width = len(sec[0])
                break

    # Clues: every remaining section's lines that match the clue shape.
    for i, sec in enumerate(body):
        if i == grid_idx:
            continue
        for line in sec:
            m = _CLUE_RE.match(line)
            if not m:
                continue
            direction, number, clue_text, raw_answer = m.groups()
            answer = normalize_answer(raw_answer or "")
            if not answer or not clue_text:
                continue
            puzzle.clues.append((direction, int(number), clue_text.strip(), answer))
    return puzzle


def read_metadata(metadata_zip_path: str | None) -> dict[str, dict[str, str]]:
    """xdid → metadata row from puzzles.tsv inside xd-metadata.zip.
    Missing zip or tsv is fine — .xd headers carry most of the same fields."""
    if not metadata_zip_path:
        return {}
    rows: dict[str, dict[str, str]] = {}
    with zipfile.ZipFile(metadata_zip_path) as zf:
        tsv_names = [n for n in zf.namelist() if n.endswith("puzzles.tsv")]
        if not tsv_names:
            return {}
        with zf.open(tsv_names[0]) as fh:
            text_fh = io.TextIOWrapper(fh, encoding="utf-8", errors="replace")
            header = text_fh.readline().rstrip("\n").split("\t")
            cols = [c.strip().lower() for c in header]
            for line in text_fh:
                values = line.rstrip("\n").split("\t")
                row = dict(zip(cols, values))
                xdid = row.get("xdid", "").strip()
                if xdid:
                    rows[xdid] = row
    return rows


def iter_xd_members(puzzles_zip_path: str) -> Iterator[tuple[str, str]]:
    """Yield (xdid, file_text) for each .xd member, streamed without extraction."""
    with zipfile.ZipFile(puzzles_zip_path) as zf:
        for info in zf.infolist():
            if info.is_dir() or not info.filename.endswith(".xd"):
                continue
            with zf.open(info) as fh:
                content = fh.read().decode("utf-8", errors="replace")
            yield xdid_from_member(info.filename), content


@dataclass
class IngestReport:
    puzzles_ingested: int = 0
    puzzles_skipped: int = 0  # already present (idempotent re-run)
    clues_ingested: int = 0
    parse_errors: list[str] = field(default_factory=list)


def _get_state(conn: Connection, key: str) -> str | None:
    return conn.execute(
        text("SELECT value FROM ingest_state WHERE key = :k"), {"k": key}
    ).scalar()


def _set_state(conn: Connection, key: str, value: str) -> None:
    conn.execute(
        text(
            "INSERT INTO ingest_state (key, value) VALUES (:k, :v) "
            "ON CONFLICT(key) DO UPDATE SET value = :v"
        ),
        {"k": key, "v": value},
    )


def _ensure_publication(conn: Connection, cache: dict[str, int], pubid: str) -> int:
    if pubid in cache:
        return cache[pubid]
    row_id = conn.execute(
        text("SELECT id FROM publications WHERE pubid = :p"), {"p": pubid}
    ).scalar()
    if row_id is None:
        row_id = conn.execute(
            text("INSERT INTO publications (pubid, name) VALUES (:p, :n)"),
            {"p": pubid, "n": KNOWN_PUBLICATIONS.get(pubid)},
        ).lastrowid
    cache[pubid] = row_id
    return row_id


def ingest_puzzles(
    engine: Engine,
    puzzles_zip_path: str,
    metadata_zip_path: str | None = None,
    limit: int | None = None,
    dry_run: bool = False,
    progress: Callable[[str], None] = lambda _msg: None,
) -> IngestReport:
    """Phase 1+2: stream .xd files into puzzles/clues. Idempotent by xdid."""
    report = IngestReport()
    metadata = read_metadata(metadata_zip_path)
    progress(f"metadata rows: {len(metadata)}")

    with engine.connect() as conn:
        conn.execute(text("PRAGMA synchronous=OFF"))  # bulk load; FTS rebuilt after
        existing = {
            row[0] for row in conn.execute(text("SELECT xdid FROM puzzles")).all()
        }
        pub_cache: dict[str, int] = {}
        clue_buffer: list[dict] = []
        seen = 0

        def flush() -> None:
            if clue_buffer and not dry_run:
                conn.execute(
                    text(
                        "INSERT INTO clues (puzzle_id, answer, direction, number, clue_text) "
                        "VALUES (:puzzle_id, :answer, :direction, :number, :clue_text)"
                    ),
                    clue_buffer,
                )
                conn.commit()
            clue_buffer.clear()

        for xdid, content in iter_xd_members(puzzles_zip_path):
            if limit is not None and seen >= limit:
                break
            seen += 1
            if xdid in existing:
                report.puzzles_skipped += 1
                continue
            try:
                puzzle = parse_xd(content, xdid)
            except Exception as exc:  # tolerate single bad files, report loudly
                report.parse_errors.append(f"{xdid}: {exc}")
                continue

            meta = metadata.get(xdid, {})
            m = _XDID_RE.match(xdid)
            pubid = m.group(1) if m else xdid
            date = parse_date(meta.get("date")) or puzzle.date

            if dry_run:
                report.puzzles_ingested += 1
                report.clues_ingested += len(puzzle.clues)
                continue

            pub_id = _ensure_publication(conn, pub_cache, pubid)
            puzzle_id = conn.execute(
                text(
                    "INSERT INTO puzzles (xdid, publication_id, date, title, author, "
                    "editor, copyright, width, height) VALUES (:xdid, :pub, :date, "
                    ":title, :author, :editor, :copyright, :width, :height)"
                ),
                {
                    "xdid": xdid,
                    "pub": pub_id,
                    # ISO string, not datetime.date: sqlite3's implicit date
                    # adapter is deprecated (3.12+) and the column stores text.
                    "date": date.isoformat() if date else None,
                    "title": meta.get("title") or puzzle.title,
                    "author": meta.get("author") or puzzle.author,
                    "editor": meta.get("editor") or puzzle.editor,
                    "copyright": meta.get("copyright") or puzzle.copyright,
                    "width": puzzle.width,
                    "height": puzzle.height,
                },
            ).lastrowid
            existing.add(xdid)
            report.puzzles_ingested += 1
            for direction, number, clue_text_value, answer in puzzle.clues:
                clue_buffer.append(
                    {
                        "puzzle_id": puzzle_id,
                        "answer": answer,
                        "direction": direction,
                        "number": number,
                        "clue_text": clue_text_value,
                    }
                )
                report.clues_ingested += 1
            if len(clue_buffer) >= BATCH_SIZE:
                flush()
                progress(f"{report.puzzles_ingested} puzzles, {report.clues_ingested} clues…")

        flush()
        if not dry_run:
            _set_state(conn, "stats_dirty", "1")
            conn.commit()
    return report


def rebuild_stats(engine: Engine, progress: Callable[[str], None] = lambda _msg: None) -> None:
    """Phase 3+4: recompute entries/entry_year_counts from clues in set-based
    SQL, then rebuild the FTS index. Re-runnable from scratch at any time."""
    with engine.connect() as conn:
        progress("rebuilding entry stats…")
        # Preserve wordlist scores across the rebuild (they come from the .dict,
        # not the corpus).
        conn.execute(text("DELETE FROM entry_year_counts"))
        conn.execute(
            text(
                """
                INSERT INTO entries (answer, length, appearance_count, first_seen, last_seen)
                SELECT c.answer, LENGTH(c.answer), COUNT(*), MIN(p.date), MAX(p.date)
                FROM clues c JOIN puzzles p ON p.id = c.puzzle_id
                GROUP BY c.answer
                ON CONFLICT(answer) DO UPDATE SET
                    appearance_count = excluded.appearance_count,
                    first_seen = excluded.first_seen,
                    last_seen = excluded.last_seen
                """
            )
        )
        conn.execute(
            text(
                """
                INSERT INTO entry_year_counts (entry_id, year, count)
                SELECT e.id, CAST(STRFTIME('%Y', p.date) AS INTEGER), COUNT(*)
                FROM clues c
                JOIN puzzles p ON p.id = c.puzzle_id AND p.date IS NOT NULL
                JOIN entries e ON e.answer = c.answer
                GROUP BY e.id, STRFTIME('%Y', p.date)
                """
            )
        )
        progress("rebuilding FTS index…")
        conn.execute(text("INSERT INTO clues_fts(clues_fts) VALUES('rebuild')"))
        _set_state(conn, "stats_dirty", "0")
        conn.commit()

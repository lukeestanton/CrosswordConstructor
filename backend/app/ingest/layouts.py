"""Layout extraction: mine black-square patterns from NYT puzzles.

Quick Start suggests starting layouts mined from published NYT grids. This
module streams the xd corpus, keeps only NYT 15x15 / 21x21 grids that pass
the conservative NYT rule set (rotational symmetry, every slot >= 3,
connected, word-count caps), dedupes identical block patterns (many puzzles
share one — the share count is the popularity signal), and rebuilds the
``layouts`` + ``layout_slot_lengths`` tables wholesale. Derived data: the
rebuild is idempotent the same way ``rebuild_stats`` is.
"""

from __future__ import annotations

import datetime
from collections import deque
from dataclasses import dataclass, field
from typing import Callable

from sqlalchemy import text
from sqlalchemy.engine import Engine

from .xd import _XDID_RE, iter_xd_members, parse_date, parse_xd

ALLOWED_SIZES = {15, 21}
# NYT maximums: 78 words daily 15x15 (themed), 140 words Sunday 21x21.
MAX_WORD_COUNT = {15: 78, 21: 140}
MIN_SLOT_LEN = 3


def pattern_from_grid(grid: list[str]) -> str:
    """Grid rows -> canonical pattern: '#' block, '.' letter cell (rebus
    digits/underscores are letter cells), rows joined with newlines."""
    return "\n".join(
        "".join("#" if ch == "#" else "." for ch in row) for row in grid
    )


def is_rotationally_symmetric(pattern: str) -> bool:
    cells = pattern.replace("\n", "")
    n = len(cells)
    return all((cells[i] == "#") == (cells[n - 1 - i] == "#") for i in range(n))


def _runs(rows: list[str]) -> list[int]:
    """Lengths of maximal horizontal runs of letter cells."""
    lengths: list[int] = []
    for row in rows:
        run = 0
        for ch in row + "#":
            if ch == "#":
                if run:
                    lengths.append(run)
                run = 0
            else:
                run += 1
    return lengths


@dataclass
class LayoutStats:
    width: int
    height: int
    block_count: int
    across_lengths: list[int]
    down_lengths: list[int]

    @property
    def word_count(self) -> int:
        return len(self.across_lengths) + len(self.down_lengths)

    @property
    def slot_lengths(self) -> list[int]:
        return self.across_lengths + self.down_lengths


def scan_runs(pattern: str) -> LayoutStats:
    rows = pattern.split("\n")
    cols = ["".join(row[c] for row in rows) for c in range(len(rows[0]))]
    return LayoutStats(
        width=len(rows[0]),
        height=len(rows),
        block_count=pattern.count("#"),
        across_lengths=_runs(rows),
        down_lengths=_runs(cols),
    )


def _is_connected(rows: list[str]) -> bool:
    """All letter cells form one orthogonally connected region."""
    height, width = len(rows), len(rows[0])
    start = None
    total = 0
    for r in range(height):
        for c in range(width):
            if rows[r][c] != "#":
                total += 1
                if start is None:
                    start = (r, c)
    if start is None:
        return False
    seen = {start}
    queue = deque([start])
    while queue:
        r, c = queue.popleft()
        for nr, nc in ((r - 1, c), (r + 1, c), (r, c - 1), (r, c + 1)):
            if 0 <= nr < height and 0 <= nc < width and rows[nr][nc] != "#":
                if (nr, nc) not in seen:
                    seen.add((nr, nc))
                    queue.append((nr, nc))
    return len(seen) == total


def validate_layout(pattern: str, width: int, height: int) -> bool:
    """Conservative NYT rule set. Rejecting an unusual-but-published grid is
    fine (Quick Start wants safe starting points); accepting a rule-breaking
    one is not."""
    if width != height or width not in ALLOWED_SIZES:
        return False
    rows = pattern.split("\n")
    if len(rows) != height or any(len(row) != width for row in rows):
        return False
    if not is_rotationally_symmetric(pattern):
        return False
    stats = scan_runs(pattern)
    if any(n < MIN_SLOT_LEN for n in stats.slot_lengths):
        return False
    if stats.word_count > MAX_WORD_COUNT[width]:
        return False
    return _is_connected(rows)


@dataclass
class LayoutReport:
    scanned: int = 0  # NYT members seen
    accepted: int = 0  # puzzles whose layout passed validation
    rejected: int = 0  # NYT 15/21 grids failing validation
    layouts: int = 0  # unique patterns stored
    parse_errors: list[str] = field(default_factory=list)


@dataclass
class _PatternAgg:
    count: int = 0
    first_used: datetime.date | None = None
    last_used: datetime.date | None = None
    sample_xdid: str = ""


def build_layouts(
    engine: Engine,
    puzzles_zip_path: str,
    limit: int | None = None,
    dry_run: bool = False,
    progress: Callable[[str], None] = lambda _msg: None,
) -> LayoutReport:
    """Stream the corpus, aggregate unique valid patterns, rebuild the tables."""
    report = LayoutReport()
    agg: dict[str, _PatternAgg] = {}

    for xdid, content in iter_xd_members(puzzles_zip_path):
        m = _XDID_RE.match(xdid)
        if not m or m.group(1) != "nyt":
            continue
        if limit is not None and report.scanned >= limit:
            break
        report.scanned += 1
        try:
            puzzle = parse_xd(content, xdid)
        except Exception as exc:  # tolerate single bad files, report loudly
            report.parse_errors.append(f"{xdid}: {exc}")
            continue
        if puzzle.grid is None or puzzle.width is None or puzzle.height is None:
            continue
        if puzzle.width != puzzle.height or puzzle.width not in ALLOWED_SIZES:
            continue
        pattern = pattern_from_grid(puzzle.grid)
        if not validate_layout(pattern, puzzle.width, puzzle.height):
            report.rejected += 1
            continue
        report.accepted += 1
        entry = agg.setdefault(pattern, _PatternAgg())
        entry.count += 1
        date = puzzle.date or parse_date(xdid)
        if date is not None:
            if entry.first_used is None or date < entry.first_used:
                entry.first_used = date
            if entry.last_used is None or date > entry.last_used:
                entry.last_used = date
                entry.sample_xdid = xdid
        elif not entry.sample_xdid:
            entry.sample_xdid = xdid
        if report.scanned % 5000 == 0:
            progress(f"{report.scanned} scanned, {len(agg)} unique layouts…")

    report.layouts = len(agg)
    if dry_run:
        return report

    with engine.connect() as conn:
        conn.execute(text("DELETE FROM layout_slot_lengths"))
        conn.execute(text("DELETE FROM layouts"))
        for pattern, entry in agg.items():
            stats = scan_runs(pattern)
            layout_id = conn.execute(
                text(
                    "INSERT INTO layouts (width, height, pattern, word_count, "
                    "block_count, max_slot_len, mean_slot_len, usage_count, "
                    "first_used, last_used, sample_xdid) VALUES (:w, :h, :p, "
                    ":wc, :bc, :maxlen, :meanlen, :uses, :first, :last, :xdid)"
                ),
                {
                    "w": stats.width,
                    "h": stats.height,
                    "p": pattern,
                    "wc": stats.word_count,
                    "bc": stats.block_count,
                    "maxlen": max(stats.slot_lengths),
                    "meanlen": sum(stats.slot_lengths) / len(stats.slot_lengths),
                    "uses": entry.count,
                    "first": entry.first_used.isoformat() if entry.first_used else None,
                    "last": entry.last_used.isoformat() if entry.last_used else None,
                    "xdid": entry.sample_xdid or None,
                },
            ).lastrowid
            by_length: dict[int, list[int]] = {}
            for n in stats.across_lengths:
                by_length.setdefault(n, [0, 0])[0] += 1
            for n in stats.down_lengths:
                by_length.setdefault(n, [0, 0])[1] += 1
            conn.execute(
                text(
                    "INSERT INTO layout_slot_lengths (layout_id, length, "
                    "across_count, down_count) VALUES (:lid, :len, :ac, :dc)"
                ),
                [
                    {"lid": layout_id, "len": n, "ac": ac, "dc": dc}
                    for n, (ac, dc) in sorted(by_length.items())
                ],
            )
        conn.commit()
    return report

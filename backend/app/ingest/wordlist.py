"""Wordlist ingestion.

Loads a Crossfire-format ``.dict`` (``WORD;score`` per line) into ``entries``
so every scorable word has an entry page even if the corpus has never seen it
(``appearance_count`` stays 0), and merges scores onto corpus-born rows.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Callable, Iterator

from sqlalchemy import text
from sqlalchemy.engine import Engine

BATCH_SIZE = 10_000
_LINE_RE = re.compile(r"^([A-Za-z]+)\s*;\s*(\d+)")


def iter_dict_lines(path: Path) -> Iterator[tuple[str, int]]:
    with path.open(encoding="utf-8", errors="replace") as fh:
        for line in fh:
            m = _LINE_RE.match(line.strip())
            if m:
                yield m.group(1).upper(), int(m.group(2))


def ingest_wordlist(
    engine: Engine,
    dict_path: Path,
    progress: Callable[[str], None] = lambda _msg: None,
) -> int:
    """Upsert wordlist words/scores into entries. Returns rows processed."""
    count = 0
    buffer: list[dict] = []
    with engine.connect() as conn:
        conn.execute(text("PRAGMA synchronous=OFF"))

        def flush() -> None:
            if buffer:
                conn.execute(
                    text(
                        "INSERT INTO entries (answer, length, appearance_count, wordlist_score) "
                        "VALUES (:answer, :length, 0, :score) "
                        "ON CONFLICT(answer) DO UPDATE SET wordlist_score = excluded.wordlist_score"
                    ),
                    buffer,
                )
                conn.commit()
            buffer.clear()

        for word, score in iter_dict_lines(dict_path):
            buffer.append({"answer": word, "length": len(word), "score": score})
            count += 1
            if len(buffer) >= BATCH_SIZE:
                flush()
                if count % 100_000 == 0:
                    progress(f"{count} wordlist rows…")
        flush()
    return count

"""Entry page payload assembly.

A "sense" is a group of citations sharing a normalized clue text, ranked by
count — deliberately no clustering and no LLM in v1 (see docs/decisions.md).
Familiarity/register lines are derived from real numbers only; nothing is
invented (the mockup's IPA pronunciation is omitted for the same reason).
"""

from __future__ import annotations

import datetime
import re
from dataclasses import dataclass, field

from sqlalchemy import text
from sqlalchemy.orm import Session

MAX_CITATIONS_PER_SENSE = 6
MAX_SENSES = 12
VOWELS = set("AEIOU")

_NORM_RE = re.compile(r"[^a-z0-9 ]+")
_WS_RE = re.compile(r"\s+")
# Trailing enumerations like "(4)" or "(2,3)" add noise to grouping.
_ENUM_RE = re.compile(r"\s*\(\d+(?:[,-]\s*\d+)*\)\s*$")


def normalize_clue(clue: str) -> str:
    s = _ENUM_RE.sub("", clue.lower())
    s = _NORM_RE.sub(" ", s)
    return _WS_RE.sub(" ", s).strip()


def pattern_of(answer: str) -> str:
    """ETUI → 'V·C·V·V'."""
    return "·".join("V" if ch in VOWELS else "C" for ch in answer)


def familiarity_of(score: int | None, appearance_count: int) -> str | None:
    """Bucket from the wordlist score — the closest honest 'familiarity' we have."""
    if score is None:
        return None if appearance_count == 0 else "unscored"
    if score >= 80:
        return "high"
    if score >= 60:
        return "medium"
    return "low"


def register_of(score: int | None, appearance_count: int) -> list[str]:
    """Heuristic register tags: frequent-in-grids + weak wordlist score is the
    working definition of crosswordese; long history earns 'classic'."""
    tags: list[str] = []
    if appearance_count >= 100 and score is not None and score < 60:
        tags.append("crosswordese")
    if appearance_count >= 50:
        tags.append("classic")
    return tags


@dataclass
class Citation:
    date: datetime.date | None
    publication: str | None
    clue_text: str


@dataclass
class Sense:
    display: str  # most common original clue text in the group
    count: int
    share: float
    citations: list[Citation] = field(default_factory=list)


def build_senses(rows: list[tuple[str, datetime.date | None, str | None]]) -> list[Sense]:
    """rows: (clue_text, puzzle_date, publication_name) for one answer."""
    groups: dict[str, list[tuple[str, datetime.date | None, str | None]]] = {}
    for row in rows:
        groups.setdefault(normalize_clue(row[0]), []).append(row)
    total = len(rows) or 1

    senses: list[Sense] = []
    for grouped in groups.values():
        # Display text: the most frequent original casing/punctuation variant.
        variants: dict[str, int] = {}
        for clue_text, _, _ in grouped:
            variants[clue_text] = variants.get(clue_text, 0) + 1
        display = max(variants, key=lambda k: variants[k])
        dated = sorted(
            grouped, key=lambda r: (r[1] is None, r[1] or datetime.date.min), reverse=True
        )
        senses.append(
            Sense(
                display=display,
                count=len(grouped),
                share=len(grouped) / total,
                citations=[
                    Citation(date=d, publication=p, clue_text=c)
                    for c, d, p in dated[:MAX_CITATIONS_PER_SENSE]
                ],
            )
        )
    senses.sort(key=lambda s: s.count, reverse=True)
    return senses[:MAX_SENSES]


def fetch_entry_payload(session: Session, answer: str) -> dict | None:
    entry = session.execute(
        text(
            "SELECT id, answer, length, appearance_count, first_seen, last_seen, "
            "wordlist_score FROM entries WHERE answer = :a"
        ),
        {"a": answer},
    ).one_or_none()
    if entry is None:
        return None
    entry_id, answer, length, count, first_seen, last_seen, score = entry

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
        {"a": answer},
    ).all()

    histogram = session.execute(
        text(
            "SELECT year, count FROM entry_year_counts WHERE entry_id = :id ORDER BY year"
        ),
        {"id": entry_id},
    ).all()

    neighbors = {
        "prev": session.execute(
            text("SELECT answer FROM entries WHERE answer < :a ORDER BY answer DESC LIMIT 1"),
            {"a": answer},
        ).scalar(),
        "next": session.execute(
            text("SELECT answer FROM entries WHERE answer > :a ORDER BY answer ASC LIMIT 1"),
            {"a": answer},
        ).scalar(),
    }

    see_also = [
        row[0]
        for row in session.execute(
            text(
                "SELECT answer FROM entries WHERE answer LIKE :prefix AND answer != :a "
                "ORDER BY appearance_count DESC LIMIT 4"
            ),
            {"prefix": f"{answer}%", "a": answer},
        ).all()
    ]

    senses = build_senses([(r[0], _to_date(r[1]), r[2]) for r in clue_rows])
    return {
        "answer": answer,
        "length": length,
        "pattern": pattern_of(answer),
        "wordlist_score": score,
        "appearance_count": count,
        "first_seen": _iso(first_seen),
        "last_seen": _iso(last_seen),
        "familiarity": familiarity_of(score, count),
        "register": register_of(score, count),
        "year_histogram": [{"year": y, "count": c} for y, c in histogram],
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
                    for c in s.citations
                ],
            }
            for s in senses
        ],
        "neighbors": neighbors,
        "see_also": see_also,
    }


def _to_date(value) -> datetime.date | None:
    """SQLite hands dates back as ISO strings on raw queries."""
    if value is None or isinstance(value, datetime.date):
        return value
    try:
        return datetime.date.fromisoformat(str(value))
    except ValueError:
        return None


def _iso(value) -> str | None:
    d = _to_date(value)
    return d.isoformat() if d else None

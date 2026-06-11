"""ORM models.

Schema notes:

* ``clues.answer`` is normalized to bare A–Z uppercase at ingest time so joins
  against ``entries`` and the wordlist are exact.
* ``entries`` is the denormalized per-answer rollup the entry page reads —
  recomputed wholesale by the ingestion stats phase, never updated row-by-row.
* ``clues_fts`` (FTS5) lives only in the Alembic migration: SQLAlchemy can't
  model virtual tables. Ingestion is its only writer (full rebuild after bulk
  load); there are deliberately no sync triggers — see docs/decisions.md.
"""

from __future__ import annotations

import datetime

from sqlalchemy import Date, ForeignKey, Index, Integer, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


class Publication(Base):
    __tablename__ = "publications"

    id: Mapped[int] = mapped_column(primary_key=True)
    # Short id as used in xdids ("nyt", "lat", "wsj", ...).
    pubid: Mapped[str] = mapped_column(Text, unique=True)
    name: Mapped[str | None] = mapped_column(Text)

    puzzles: Mapped[list["Puzzle"]] = relationship(back_populates="publication")


class Puzzle(Base):
    __tablename__ = "puzzles"

    id: Mapped[int] = mapped_column(primary_key=True)
    # Canonical xd identifier, e.g. "nyt1993-02-07". Idempotency key for ingest.
    xdid: Mapped[str] = mapped_column(Text, unique=True)
    publication_id: Mapped[int | None] = mapped_column(ForeignKey("publications.id"))
    date: Mapped[datetime.date | None] = mapped_column(Date)
    title: Mapped[str | None] = mapped_column(Text)
    author: Mapped[str | None] = mapped_column(Text)
    editor: Mapped[str | None] = mapped_column(Text)
    copyright: Mapped[str | None] = mapped_column(Text)
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)

    publication: Mapped[Publication | None] = relationship(back_populates="puzzles")
    clues: Mapped[list["Clue"]] = relationship(back_populates="puzzle")


class Clue(Base):
    __tablename__ = "clues"

    id: Mapped[int] = mapped_column(primary_key=True)
    puzzle_id: Mapped[int] = mapped_column(ForeignKey("puzzles.id"))
    answer: Mapped[str] = mapped_column(Text)  # normalized A–Z uppercase
    direction: Mapped[str] = mapped_column(Text)  # 'A' or 'D'
    number: Mapped[int | None] = mapped_column(Integer)
    clue_text: Mapped[str] = mapped_column(Text)

    puzzle: Mapped[Puzzle] = relationship(back_populates="clues")

    __table_args__ = (Index("ix_clues_answer", "answer"),)


class Entry(Base):
    __tablename__ = "entries"

    id: Mapped[int] = mapped_column(primary_key=True)
    answer: Mapped[str] = mapped_column(Text, unique=True)
    length: Mapped[int] = mapped_column(Integer)
    appearance_count: Mapped[int] = mapped_column(Integer, default=0)
    first_seen: Mapped[datetime.date | None] = mapped_column(Date)
    last_seen: Mapped[datetime.date | None] = mapped_column(Date)
    # Score from the active wordlist (Crossfire .dict, 0–100); NULL if absent.
    wordlist_score: Mapped[int | None] = mapped_column(Integer)

    __table_args__ = (Index("ix_entries_length", "length"),)


class EntryYearCount(Base):
    """Per-year appearance counts — the entry page histogram."""

    __tablename__ = "entry_year_counts"

    entry_id: Mapped[int] = mapped_column(ForeignKey("entries.id"), primary_key=True)
    year: Mapped[int] = mapped_column(Integer, primary_key=True)
    count: Mapped[int] = mapped_column(Integer)


class Layout(Base):
    """A unique black-square pattern mined from published NYT grids.
    ``pattern`` is '\\n'-joined rows of '#'/'.'; ``usage_count`` is how many
    puzzles share it. Derived data — rebuilt wholesale by build_layouts."""

    __tablename__ = "layouts"

    id: Mapped[int] = mapped_column(primary_key=True)
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    pattern: Mapped[str] = mapped_column(Text, unique=True)
    word_count: Mapped[int] = mapped_column(Integer)
    block_count: Mapped[int] = mapped_column(Integer)
    max_slot_len: Mapped[int] = mapped_column(Integer)
    mean_slot_len: Mapped[float] = mapped_column()
    usage_count: Mapped[int] = mapped_column(Integer)
    first_used: Mapped[datetime.date | None] = mapped_column(Date)
    last_used: Mapped[datetime.date | None] = mapped_column(Date)
    sample_xdid: Mapped[str | None] = mapped_column(Text)

    slot_lengths: Mapped[list["LayoutSlotLength"]] = relationship(
        back_populates="layout"
    )

    __table_args__ = (Index("ix_layouts_size_pop", "width", "height", "usage_count"),)


class LayoutSlotLength(Base):
    """Slot-length signature row: how many across/down slots of ``length``
    a layout has. Backs the multiset matching query for must-include words."""

    __tablename__ = "layout_slot_lengths"

    layout_id: Mapped[int] = mapped_column(ForeignKey("layouts.id"), primary_key=True)
    length: Mapped[int] = mapped_column(Integer, primary_key=True)
    across_count: Mapped[int] = mapped_column(Integer)
    down_count: Mapped[int] = mapped_column(Integer)

    layout: Mapped[Layout] = relationship(back_populates="slot_lengths")

    __table_args__ = (Index("ix_lsl_length", "length", "across_count"),)


class IngestState(Base):
    """Key/value bookkeeping so long ingestion runs are resumable."""

    __tablename__ = "ingest_state"

    key: Mapped[str] = mapped_column(Text, primary_key=True)
    value: Mapped[str] = mapped_column(Text)


class Grid(Base):
    """A constructor grid. ``payload`` is the schema-versioned editor state JSON;
    the editor owns its shape, the backend only stores and versions it."""

    __tablename__ = "grids"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(Text, default="")
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    payload: Mapped[str] = mapped_column(Text)  # JSON
    # Optimistic concurrency: PUT must carry the rev it loaded; mismatch → 409.
    rev: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime.datetime] = mapped_column(default=datetime.datetime.utcnow)
    updated_at: Mapped[datetime.datetime] = mapped_column(
        default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow
    )

    snapshots: Mapped[list["GridSnapshot"]] = relationship(
        back_populates="grid", cascade="all, delete-orphan"
    )


class GridSnapshot(Base):
    __tablename__ = "grid_snapshots"

    id: Mapped[int] = mapped_column(primary_key=True)
    grid_id: Mapped[int] = mapped_column(ForeignKey("grids.id"))
    name: Mapped[str] = mapped_column(Text)
    payload: Mapped[str] = mapped_column(Text)  # JSON
    created_at: Mapped[datetime.datetime] = mapped_column(default=datetime.datetime.utcnow)

    grid: Mapped[Grid] = relationship(back_populates="snapshots")


class Solve(Base):
    """One row per NYT daily puzzle the solver has seen/solved."""

    __tablename__ = "solves"

    id: Mapped[int] = mapped_column(primary_key=True)
    puzzle_date: Mapped[datetime.date] = mapped_column(Date, unique=True)
    nyt_puzzle_id: Mapped[int | None] = mapped_column(Integer)
    solved: Mapped[bool] = mapped_column(default=False)
    solve_time_secs: Mapped[int | None] = mapped_column(Integer)
    day_of_week: Mapped[int] = mapped_column(Integer)  # 0=Mon … 6=Sun
    raw: Mapped[str | None] = mapped_column(Text)  # JSON as returned (minus nothing secret)
    synced_at: Mapped[datetime.datetime] = mapped_column(default=datetime.datetime.utcnow)


class PollResult(Base):
    __tablename__ = "poll_results"

    id: Mapped[int] = mapped_column(primary_key=True)
    puzzle_date: Mapped[datetime.date] = mapped_column(Date)
    source: Mapped[str] = mapped_column(Text)
    sample_size: Mapped[int | None] = mapped_column(Integer)
    avg_rating: Mapped[float | None] = mapped_column()
    distribution: Mapped[str | None] = mapped_column(Text)  # JSON histogram

    __table_args__ = (UniqueConstraint("puzzle_date", "source"),)


class RexPost(Base):
    __tablename__ = "rex_posts"

    id: Mapped[int] = mapped_column(primary_key=True)
    puzzle_date: Mapped[datetime.date] = mapped_column(Date, unique=True)
    title: Mapped[str] = mapped_column(Text)
    url: Mapped[str] = mapped_column(Text)
    published_at: Mapped[datetime.datetime | None] = mapped_column()
    relative_difficulty: Mapped[str | None] = mapped_column(Text)
    summary_raw: Mapped[str | None] = mapped_column(Text)


class WordTag(Base):
    """Machine-produced word-type tags (see services/word_tags.py for the
    taxonomy). One row per normalized wordlist entry that received tags or
    sidecar data; corrections go in WordTagOverride, never here."""

    __tablename__ = "word_tags"

    word: Mapped[str] = mapped_column(Text, primary_key=True)  # A–Z uppercase
    mask: Mapped[int] = mapped_column(Integer)
    familiarity: Mapped[int | None] = mapped_column(Integer)  # 0..4
    lang: Mapped[str | None] = mapped_column(Text)  # ISO 639-1, FOREIGN only
    gloss: Mapped[str | None] = mapped_column(Text)  # reserved for later pass
    source: Mapped[str] = mapped_column(Text)
    model: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime.datetime] = mapped_column(default=datetime.datetime.utcnow)


class WordTagOverride(Base):
    """Manual full-replacement mask per word (0 clears all tags); merged over
    word_tags via COALESCE at read time."""

    __tablename__ = "word_tag_overrides"

    word: Mapped[str] = mapped_column(Text, primary_key=True)
    mask: Mapped[int] = mapped_column(Integer)
    familiarity: Mapped[int | None] = mapped_column(Integer)
    note: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime.datetime] = mapped_column(default=datetime.datetime.utcnow)


class Digest(Base):
    """Cached spoiler-free LLM digests, one per puzzle date."""

    __tablename__ = "digests"

    id: Mapped[int] = mapped_column(primary_key=True)
    puzzle_date: Mapped[datetime.date] = mapped_column(Date, unique=True)
    model: Mapped[str] = mapped_column(Text)
    content: Mapped[str] = mapped_column(Text)
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime.datetime] = mapped_column(default=datetime.datetime.utcnow)

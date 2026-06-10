"""Clue corpus: publications, puzzles, clues, entries, histogram, FTS5.

Revision ID: 0001
Revises:
Create Date: 2026-06-10

``clues_fts`` is an FTS5 external-content table over ``clues`` and must be
created with raw DDL (SQLAlchemy cannot model virtual tables). There are no
sync triggers by design: ingestion is the only writer of ``clues`` and ends
with a full FTS rebuild, which is faster and simpler than trigger upkeep.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "publications",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("pubid", sa.Text(), nullable=False, unique=True),
        sa.Column("name", sa.Text(), nullable=True),
    )
    op.create_table(
        "puzzles",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("xdid", sa.Text(), nullable=False, unique=True),
        sa.Column("publication_id", sa.Integer(), sa.ForeignKey("publications.id"), nullable=True),
        sa.Column("date", sa.Date(), nullable=True),
        sa.Column("title", sa.Text(), nullable=True),
        sa.Column("author", sa.Text(), nullable=True),
        sa.Column("editor", sa.Text(), nullable=True),
        sa.Column("copyright", sa.Text(), nullable=True),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
    )
    op.create_index("ix_puzzles_date", "puzzles", ["date"])
    op.create_table(
        "clues",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("puzzle_id", sa.Integer(), sa.ForeignKey("puzzles.id"), nullable=False),
        sa.Column("answer", sa.Text(), nullable=False),
        sa.Column("direction", sa.Text(), nullable=False),
        sa.Column("number", sa.Integer(), nullable=True),
        sa.Column("clue_text", sa.Text(), nullable=False),
    )
    op.create_index("ix_clues_answer", "clues", ["answer"])
    op.create_table(
        "entries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("answer", sa.Text(), nullable=False, unique=True),
        sa.Column("length", sa.Integer(), nullable=False),
        sa.Column("appearance_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("first_seen", sa.Date(), nullable=True),
        sa.Column("last_seen", sa.Date(), nullable=True),
        sa.Column("wordlist_score", sa.Integer(), nullable=True),
    )
    op.create_index("ix_entries_length", "entries", ["length"])
    op.create_table(
        "entry_year_counts",
        sa.Column("entry_id", sa.Integer(), sa.ForeignKey("entries.id"), primary_key=True),
        sa.Column("year", sa.Integer(), primary_key=True),
        sa.Column("count", sa.Integer(), nullable=False),
    )
    op.create_table(
        "ingest_state",
        sa.Column("key", sa.Text(), primary_key=True),
        sa.Column("value", sa.Text(), nullable=False),
    )
    op.execute(
        "CREATE VIRTUAL TABLE clues_fts USING fts5("
        "clue_text, answer UNINDEXED, content='clues', content_rowid='id', "
        # Porter stemming so 'needle' finds 'needles' — clue search wants recall.
        "tokenize='porter unicode61'"
        ")"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS clues_fts")
    op.drop_table("ingest_state")
    op.drop_table("entry_year_counts")
    op.drop_table("entries")
    op.drop_table("clues")
    op.drop_table("puzzles")
    op.drop_table("publications")

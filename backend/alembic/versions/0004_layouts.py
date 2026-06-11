"""Quick Start layout library: layouts + layout_slot_lengths.

Revision ID: 0004
Revises: 0003
Create Date: 2026-06-10

Unique black-square patterns mined from published NYT 15x15/21x21 grids
(``usage_count`` = how many puzzles share the pattern — the popularity
signal). ``layout_slot_lengths`` is the queryable slot-length signature: one
row per (layout, length) with across/down counts, so "which layouts have
across slots for lengths [15, 11, 11, 9]" is a multiset query (OR + HAVING
COUNT(*) = n) instead of JSON parsing. Both tables are derived data,
rebuilt wholesale by ``build_layouts``.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "layouts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("width", sa.Integer(), nullable=False),
        sa.Column("height", sa.Integer(), nullable=False),
        sa.Column("pattern", sa.Text(), nullable=False, unique=True),
        sa.Column("word_count", sa.Integer(), nullable=False),
        sa.Column("block_count", sa.Integer(), nullable=False),
        sa.Column("max_slot_len", sa.Integer(), nullable=False),
        sa.Column("mean_slot_len", sa.Float(), nullable=False),
        sa.Column("usage_count", sa.Integer(), nullable=False),
        sa.Column("first_used", sa.Date(), nullable=True),
        sa.Column("last_used", sa.Date(), nullable=True),
        sa.Column("sample_xdid", sa.Text(), nullable=True),
    )
    op.create_index("ix_layouts_size_pop", "layouts", ["width", "height", "usage_count"])
    op.create_table(
        "layout_slot_lengths",
        sa.Column(
            "layout_id", sa.Integer(), sa.ForeignKey("layouts.id"), primary_key=True
        ),
        sa.Column("length", sa.Integer(), primary_key=True),
        sa.Column("across_count", sa.Integer(), nullable=False),
        sa.Column("down_count", sa.Integer(), nullable=False),
    )
    op.create_index(
        "ix_lsl_length", "layout_slot_lengths", ["length", "across_count"]
    )


def downgrade() -> None:
    op.drop_index("ix_lsl_length", "layout_slot_lengths")
    op.drop_table("layout_slot_lengths")
    op.drop_index("ix_layouts_size_pop", "layouts")
    op.drop_table("layouts")

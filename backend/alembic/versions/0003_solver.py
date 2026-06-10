"""Solver side: solves, poll_results, rex_posts, digests.

Revision ID: 0003
Revises: 0002
Create Date: 2026-06-10

One row per puzzle date in each table. ``solves.raw`` keeps the NYT puzzle
list entry as returned (never the cookie, never grid contents); ``digests``
caches spoiler-free LLM previews so each date is generated at most once.
``poll_results`` is keyed (puzzle_date, source) so other rating sources can
land later without a schema change.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "solves",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("puzzle_date", sa.Date(), nullable=False, unique=True),
        sa.Column("nyt_puzzle_id", sa.Integer(), nullable=True),
        sa.Column("solved", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("solve_time_secs", sa.Integer(), nullable=True),
        sa.Column("day_of_week", sa.Integer(), nullable=False),  # 0=Mon … 6=Sun
        sa.Column("raw", sa.Text(), nullable=True),
        sa.Column("synced_at", sa.DateTime(), nullable=True),
    )
    op.create_table(
        "poll_results",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("puzzle_date", sa.Date(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("sample_size", sa.Integer(), nullable=True),
        sa.Column("avg_rating", sa.Float(), nullable=True),
        sa.Column("distribution", sa.Text(), nullable=True),  # JSON histogram
        sa.UniqueConstraint("puzzle_date", "source"),
    )
    op.create_index("ix_poll_results_puzzle_date", "poll_results", ["puzzle_date"])
    op.create_table(
        "rex_posts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("puzzle_date", sa.Date(), nullable=False, unique=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("published_at", sa.DateTime(), nullable=True),
        sa.Column("relative_difficulty", sa.Text(), nullable=True),
        sa.Column("summary_raw", sa.Text(), nullable=True),
    )
    op.create_table(
        "digests",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("puzzle_date", sa.Date(), nullable=False, unique=True),
        sa.Column("model", sa.Text(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("input_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("digests")
    op.drop_table("rex_posts")
    op.drop_index("ix_poll_results_puzzle_date", "poll_results")
    op.drop_table("poll_results")
    op.drop_table("solves")

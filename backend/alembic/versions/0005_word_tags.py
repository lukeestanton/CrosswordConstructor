"""Word-type tags: word_tags + word_tag_overrides.

Revision ID: 0005
Revises: 0004
Create Date: 2026-06-11

``word_tags`` holds the machine-produced taxonomy mask per normalized word
(plus familiarity/lang/gloss sidecars from the same tagging pass; gloss is
reserved, NULL until a later enrichment run). ``word_tag_overrides`` is the
manual correction valve: a full-replacement mask per word (0 = clear all
tags), merged via COALESCE at read time so corrections never touch the
machine table.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "word_tags",
        sa.Column("word", sa.Text(), primary_key=True),  # normalized A–Z upper
        sa.Column("mask", sa.Integer(), nullable=False),
        sa.Column("familiarity", sa.Integer(), nullable=True),  # 0..4
        sa.Column("lang", sa.Text(), nullable=True),  # ISO 639-1, FOREIGN only
        sa.Column("gloss", sa.Text(), nullable=True),  # reserved for later pass
        sa.Column("source", sa.Text(), nullable=False),  # 'claude-cli' | ...
        sa.Column("model", sa.Text(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "word_tag_overrides",
        sa.Column("word", sa.Text(), primary_key=True),
        sa.Column("mask", sa.Integer(), nullable=False),  # full replacement
        sa.Column("familiarity", sa.Integer(), nullable=True),  # NULL = inherit
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("word_tag_overrides")
    op.drop_table("word_tags")

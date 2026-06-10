"""Grid persistence: grids + grid_snapshots.

Revision ID: 0002
Revises: 0001
Create Date: 2026-06-10

``grids.payload`` is the schema-versioned editor state JSON — the editor owns
its shape, the backend only stores and versions it. ``rev`` backs optimistic
concurrency (PUT must carry the rev it loaded). Snapshot deletion is handled
explicitly in the API layer rather than via ON DELETE CASCADE.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "grids",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("title", sa.Text(), nullable=False, server_default=""),
        sa.Column("width", sa.Integer(), nullable=False),
        sa.Column("height", sa.Integer(), nullable=False),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.Column("rev", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
    )
    op.create_table(
        "grid_snapshots",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("grid_id", sa.Integer(), sa.ForeignKey("grids.id"), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_grid_snapshots_grid_id", "grid_snapshots", ["grid_id"])


def downgrade() -> None:
    op.drop_index("ix_grid_snapshots_grid_id", "grid_snapshots")
    op.drop_table("grid_snapshots")
    op.drop_table("grids")

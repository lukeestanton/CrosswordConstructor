"""Alembic environment.

Wired to the app's own config + engine so migrations always target the same
SQLite database and pick up sqlite-vec. ``render_as_batch=True`` because SQLite
cannot ALTER columns in place — Alembic emits copy-and-move table rewrites.
"""

from logging.config import fileConfig

from alembic import context

# Make the app package importable when alembic runs from backend/.
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from app.config import settings  # noqa: E402
from app.db import Base, engine  # noqa: E402

# Import models so their tables register on Base.metadata (none yet in slice 1).
# from app import models  # noqa: E402,F401

config = context.config
config.set_main_option("sqlalchemy.url", settings.database_url)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=settings.database_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    with engine.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()

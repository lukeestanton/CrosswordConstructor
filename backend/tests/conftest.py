"""Test fixtures.

Tests run against an isolated temp database so they never touch the real
``backend/data/crossword.db``. We point ``DATABASE_URL`` at a temp file before
the app's modules import their (module-level) engine, then apply the real
Alembic migrations so tests exercise the same DDL production uses.

The xd corpus zips are NOT committed (280MB, and unreachable from sandboxes) —
fixture zips are assembled in-memory from the small hand-authored ``.xd``/.tsv
files in ``tests/fixtures/xd/``.
"""

from __future__ import annotations

import io
import os
import tempfile
import zipfile
from pathlib import Path

import pytest

# Set an isolated DB URL before anything imports app.db / app.config.
_tmpdir = tempfile.mkdtemp(prefix="cc-test-")
os.environ["DATABASE_URL"] = f"sqlite:///{Path(_tmpdir) / 'test.db'}"

BACKEND_ROOT = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parent / "fixtures"


@pytest.fixture(scope="session")
def migrated_db():
    """Apply all Alembic migrations to the temp database."""
    from alembic import command
    from alembic.config import Config

    cfg = Config(str(BACKEND_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_ROOT / "alembic"))
    command.upgrade(cfg, "head")

    from app.db import engine

    return engine


def build_zip(members: dict[str, str]) -> str:
    """Write an in-memory zip of {member_name: text} to a temp file, return its path."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, content in members.items():
            zf.writestr(name, content)
    path = Path(_tmpdir) / f"fixture-{len(members)}-{abs(hash(tuple(sorted(members))))}.zip"
    path.write_bytes(buf.getvalue())
    return str(path)


@pytest.fixture(scope="session")
def xd_zips() -> tuple[str, str]:
    """(puzzles_zip, metadata_zip) built from the committed fixture files,
    laid out the way the real corpus zips are (nested pub/year directories)."""
    xd_dir = FIXTURES / "xd"
    puzzles = {}
    for f in sorted(xd_dir.glob("*.xd")):
        pubid = "".join(ch for ch in f.stem if ch.isalpha())[:3]
        year = f.stem[len(pubid) : len(pubid) + 4]
        puzzles[f"crosswords/{pubid}/{year}/{f.name}"] = f.read_text()
    metadata = {"puzzles.tsv": (xd_dir / "puzzles.tsv").read_text()}
    return build_zip(puzzles), build_zip(metadata)


@pytest.fixture(scope="session")
def ingested_db(migrated_db, xd_zips):
    """Database with the fixture corpus + a mini wordlist fully ingested."""
    from app.ingest.wordlist import ingest_wordlist
    from app.ingest.xd import ingest_puzzles, rebuild_stats

    puzzles_zip, metadata_zip = xd_zips
    ingest_puzzles(migrated_db, puzzles_zip, metadata_zip_path=metadata_zip)

    wordlist = Path(_tmpdir) / "mini.dict"
    wordlist.write_text("ETUI;56\nNEEDS;85\nTRYST;80\nZYZZYVA;40\n")
    ingest_wordlist(migrated_db, wordlist)

    rebuild_stats(migrated_db)
    return migrated_db


@pytest.fixture(scope="session")
def client(ingested_db):
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        yield c

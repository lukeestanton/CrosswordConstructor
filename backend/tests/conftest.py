"""Test fixtures.

Tests run against an isolated temp database so they never touch the real
``Backend/data/crossword.db``. We point ``DATABASE_URL`` at a temp file before
the app's modules import their (module-level) engine.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest

# Set an isolated DB URL before anything imports app.db / app.config.
_tmpdir = tempfile.mkdtemp(prefix="cc-test-")
os.environ["DATABASE_URL"] = f"sqlite:///{Path(_tmpdir) / 'test.db'}"


@pytest.fixture(scope="session")
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        yield c

"""Fixtures for the ledger plugin's endpoint tests.

Mirrors apps/api/tests/conftest.py (which only applies to that tree): a
per-xdist-worker SQLite database and a TestClient over the real app
assembled by the module loader.

Caveat, shared with the uploads plugin's conftest: because this tests
directory is a package (``__init__.py``), pytest imports this file as
``app.modules.ledger.tests.conftest``, and importing the parent package
chain binds ``app.db``'s engine before the assignment below runs.  In a
full-suite run the arg-level ``apps/api/tests/conftest.py`` has already
set the per-worker URL by then (which is how the isolation actually
works); in a directory-local run the default ``scholium.db`` backs the
engine.  The tests are written to tolerate either: they anchor on the
current chain head and assert only on what an append-only log cannot
change underneath them.
"""

import os
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[4]
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

worker = os.environ.get("PYTEST_XDIST_WORKER", "gw0")
# A per-worker database so parallel tests never share (and corrupt) one file.
if "PYTEST_XDIST_WORKER" in os.environ:
    os.environ["DATABASE_URL"] = f"sqlite:///./test_{worker}.db"
else:
    os.environ.setdefault("DATABASE_URL", f"sqlite:///./test_{worker}.db")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c

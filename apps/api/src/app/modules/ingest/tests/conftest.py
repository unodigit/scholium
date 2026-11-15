"""Fixtures for the ingest plugin's endpoint tests.

Mirrors the ledger plugin's conftest: a per-xdist-worker SQLite database and a
TestClient over the app the module loader assembles.  The tests use unique
record bodies (and therefore unique cids) per test, so parallel workers never
collide on rows even when they share a database file.

Every record is signed by a fresh Ed25519 key whose did:key authenticates the
request, so nothing here depends on a shared fixture key.
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

from app.main import create_app  # noqa: E402


@pytest.fixture
def client():
    """A TestClient over a freshly assembled app.

    ``create_app()`` runs the module loader on a new ``FastAPI`` instance.  The
    app that may have been built while this package was first imported can
    predate the ingest router when importing ``app.modules.ingest`` was what
    first pulled in ``app.main``; assembling a fresh app once every plugin is
    loaded is order-independent and matches what the loader does for a real
    server.
    """
    with TestClient(create_app()) as c:
        yield c

"""Fixtures for the annotations plugin's tests.

Mirrors the other plugins' conftest: a per-xdist-worker SQLite database chosen
before ``app.db`` is imported, and a ``TestClient`` over the app the module
loader assembles.  Tests use their own fresh DIDs and unique record bodies, so
parallel workers never collide on rows even when they share a database file.
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
from nacl.signing import SigningKey  # noqa: E402
from scholium_record_core import did_key_from_signing_key  # noqa: E402

from app.main import app  # noqa: E402


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def did() -> str:
    """A fresh, valid Ed25519 did:key."""
    return did_key_from_signing_key(SigningKey.generate())

"""Fixtures for the profiles plugin's tests.

Same setup as the identity plugin's conftest: a per-xdist-worker SQLite
database and a TestClient over the real app assembled by the module loader.
The tests tolerate a shared database (they write under unique DIDs and never
assert on whole-table counts), because importing this tests package binds
``app.db``'s engine before the assignment below can run in a directory-local
run.
"""

import os
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[4]
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

worker = os.environ.get("PYTEST_XDIST_WORKER", "gw0")
if "PYTEST_XDIST_WORKER" in os.environ:
    os.environ["DATABASE_URL"] = f"sqlite:///./test_{worker}.db"
else:
    os.environ.setdefault("DATABASE_URL", f"sqlite:///./test_{worker}.db")

import uuid  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.security import issue_access_token  # noqa: E402


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def did() -> str:
    """A DID unique to this test, so parallel workers never see each other's rows."""
    return f"did:key:z6Mk{uuid.uuid4().hex}"


@pytest.fixture
def auth():
    """Build an ``Authorization`` header for ``did`` at ``tier`` (default: tier 0, a reader)."""

    def make(for_did: str, tier: int = 0) -> dict[str, str]:
        return {"Authorization": f"Bearer {issue_access_token(for_did, tier)}"}

    return make

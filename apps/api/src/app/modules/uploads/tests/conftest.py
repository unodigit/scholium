"""Fixtures for the uploads plugin's tests.

Mirrors apps/api/tests/conftest.py (which only applies to that tree):
a per-xdist-worker SQLite database, set before ``app`` is imported,
and a TestClient over the real app assembled by the module loader.
Every test also gets its own empty ``CONTENT_DIR`` under ``tmp_path``:
uploads stage their bytes there, and the default (``./data/content``)
is relative to the working directory and must never be written by tests.
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
from app.security import issue_access_token  # noqa: E402
from app.settings import settings  # noqa: E402

#: The caller ``client`` is signed in as: a tier-2 author, who owns every upload
#: that ``client`` creates.
DEFAULT_DID = "did:key:z6MkUploadsTestOwner"


def bearer(did: str = DEFAULT_DID, tier: int = 2) -> dict[str, str]:
    """An ``Authorization`` header carrying a fresh access token for ``did``."""
    return {"Authorization": f"Bearer {issue_access_token(did, tier)}"}


@pytest.fixture(autouse=True)
def content_root(tmp_path, monkeypatch) -> Path:
    """Point ``CONTENT_DIR`` at a fresh directory for the duration of a test."""
    root = tmp_path / "content"
    monkeypatch.setattr(settings, "CONTENT_DIR", str(root))
    return root


@pytest.fixture(autouse=True)
def fresh_default_owner_quota():
    """Start every test with no uploads in flight for :data:`DEFAULT_DID`.

    The test database outlives a test (and a run), and a caller's bytes in
    flight are capped, so uploads an earlier test left pending would otherwise
    count against this one.
    """
    from sqlalchemy import delete

    from app.db import SessionLocal
    from app.modules.uploads.store import Upload

    session = SessionLocal()
    try:
        session.execute(delete(Upload).where(Upload.owner_did == DEFAULT_DID))
        session.commit()
    finally:
        session.close()


@pytest.fixture
def anon_client():
    """A client that sends no credentials unless a request adds them."""
    with TestClient(app) as c:
        yield c


@pytest.fixture
def client():
    """A client signed in as :data:`DEFAULT_DID`: uploads need an authenticated owner."""
    with TestClient(app, headers=bearer()) as c:
        yield c

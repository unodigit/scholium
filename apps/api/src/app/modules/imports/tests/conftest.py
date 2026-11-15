"""Fixtures for the imports plugin's tests.

Mirrors the ingest plugin's conftest (a per-xdist-worker SQLite database and a
TestClient over a freshly assembled app) and adds what an import needs: a node
signing key written to a temporary ``NODE_KEY_PATH``, a temporary ``CONTENT_DIR``
for the metadata snapshots, mock mode switched on explicitly, and helpers that mint a unique arXiv id per test.  The test database
persists between runs, and a node mirrors a paper only once, so every test
imports an id nobody else has used.
"""

import os
import random
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

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from nacl.signing import SigningKey  # noqa: E402
from scholium_record_core import did_key_from_signing_key  # noqa: E402

from app.main import create_app  # noqa: E402
from app.security import issue_access_token  # noqa: E402
from app.settings import settings  # noqa: E402


@pytest.fixture(autouse=True)
def mock_arxiv(monkeypatch):
    """Every test starts in mock mode, whatever the environment says."""
    monkeypatch.setattr(settings, "ARXIV_MOCK", 1)


@pytest.fixture(autouse=True)
def content_dir(tmp_path, monkeypatch):
    """Snapshots go to a temporary blob directory, never the repository's."""
    path = tmp_path / "content"
    monkeypatch.setattr(settings, "CONTENT_DIR", str(path))
    return path


@pytest.fixture
def node_key(tmp_path, monkeypatch):
    """A node Ed25519 key at a temporary ``NODE_KEY_PATH``."""
    seed = SigningKey.generate()
    path = tmp_path / "node.key"
    path.write_text(seed.encode().hex())
    monkeypatch.setattr(settings, "NODE_KEY_PATH", str(path))
    return seed


@pytest.fixture
def node_did(node_key):
    return did_key_from_signing_key(node_key)


@pytest.fixture
def client():
    with TestClient(create_app()) as c:
        yield c


def headers_for(tier: int) -> dict:
    """Auth headers for a brand-new account of ``tier`` (its own write quota)."""
    did = did_key_from_signing_key(SigningKey.generate())
    return {"Authorization": f"Bearer {issue_access_token(did, tier)}"}


@pytest.fixture
def moderator():
    return headers_for(4)


def unique_arxiv_id(old_style: bool = False) -> str:
    """An arXiv id this database has (all but certainly) never seen."""
    month = random.randint(1, 12)
    if old_style:  # old-style ids ran from 1991 to 2007
        year = random.choice([*range(91, 100), *range(0, 8)])
        return f"hep-th/{year:02d}{month:02d}{random.randint(0, 998):03d}"
    return f"{random.randint(15, 26):02d}{month:02d}.{random.randint(10000, 99998)}"

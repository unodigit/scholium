"""Fixtures for the content GET acceptance tests.

Mirrors the content plugin's conftest: a per-xdist-worker SQLite database,
chosen before ``app.db`` is imported, plus a fresh ``CONTENT_DIR`` per test.
"""

import os
import tempfile
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "apps" / "api" / "src"
PKG = ROOT / "apps" / "api" / "packages"
for p in (SRC, PKG / "record-core" / "src", PKG / "cli" / "src"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

worker = os.environ.get("PYTEST_XDIST_WORKER", "gw0")
# A fresh database per session and worker: a file shared across suites or
# runs makes uniqueness rules (one review per person, one DID per ORCID)
# fail on data left behind by an earlier test.
os.environ["DATABASE_URL"] = (
    f"sqlite:///{tempfile.mkdtemp(prefix=f'scholium-acceptance-db-{worker}-')}/scholium.db"
)
os.environ.setdefault("JOBS_EAGER", "1")
# Uploaded bytes go to a per-session directory, never the repo's ./data.
os.environ["CONTENT_DIR"] = tempfile.mkdtemp(prefix="scholium-acceptance-content-")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.modules import content  # noqa: E402
from app.settings import settings  # noqa: E402


@pytest.fixture(autouse=True)
def content_root(tmp_path, monkeypatch):
    root = tmp_path / "content"
    monkeypatch.setattr(settings, "CONTENT_DIR", str(root))
    return root


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c
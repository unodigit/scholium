"""Fixtures for the content GET acceptance tests.

Mirrors the content plugin's conftest: a per-xdist-worker SQLite database,
chosen before ``app.db`` is imported, plus a fresh ``CONTENT_DIR`` per test.
"""

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "apps" / "api" / "src"
PKG = ROOT / "apps" / "api" / "packages"
for p in (SRC, PKG / "record-core" / "src", PKG / "cli" / "src"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

worker = os.environ.get("PYTEST_XDIST_WORKER", "gw0")
if "PYTEST_XDIST_WORKER" in os.environ:
    os.environ["DATABASE_URL"] = f"sqlite:///./test_{worker}.db"
else:
    os.environ.setdefault("DATABASE_URL", f"sqlite:///./test_{worker}.db")
os.environ.setdefault("JOBS_EAGER", "1")

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
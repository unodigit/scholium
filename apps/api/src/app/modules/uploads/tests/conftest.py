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
from app.settings import settings  # noqa: E402


@pytest.fixture(autouse=True)
def content_root(tmp_path, monkeypatch) -> Path:
    """Point ``CONTENT_DIR`` at a fresh directory for the duration of a test."""
    root = tmp_path / "content"
    monkeypatch.setattr(settings, "CONTENT_DIR", str(root))
    return root


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c

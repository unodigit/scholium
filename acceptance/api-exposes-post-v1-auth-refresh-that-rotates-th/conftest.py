"""Fixtures for the POST /v1/auth/refresh acceptance tests.

Mirrors the other identity acceptance conftests: sys.path setup plus a
per-xdist-worker SQLite database chosen before ``app.db`` is imported.
No node key is needed.  Every test signs in as a freshly generated
Ed25519 identity (``/v1/auth/challenge`` then ``/v1/auth/verify``) to
obtain its own refresh token, so nothing is shared between tests, xdist
workers or runs of this suite.
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
# A per-worker database so parallel tests never share (and corrupt) one file.
if "PYTEST_XDIST_WORKER" in os.environ:
    os.environ["DATABASE_URL"] = f"sqlite:///./test_{worker}.db"
else:
    os.environ.setdefault("DATABASE_URL", f"sqlite:///./test_{worker}.db")
os.environ.setdefault("JOBS_EAGER", "1")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c

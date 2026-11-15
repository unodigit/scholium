"""Fixtures for the ``POST /v1/reviews/{cid}/response`` acceptance tests
(reviews plugin, feature 114).

Mirrors the other API acceptance conftests: ``sys.path`` setup plus hermetic,
per-process state chosen *before* ``app.db`` is imported.  The API's own root
``conftest.py`` does not apply to tests that live outside ``apps/api``, so the
database, content directory and node key are pointed at a private temporary
directory here -- nothing is shared with a developer's local data, with other
xdist workers or with earlier runs of this suite.

Every test builds its own paper, its own reviewers and its own author with
freshly generated Ed25519 keys and unique titles, so tests never depend on one
another's rows even though they share one database per worker.
"""

import atexit
import os
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "apps" / "api" / "src"
PKG = ROOT / "apps" / "api" / "packages"
for p in (SRC, PKG / "record-core" / "src", PKG / "cli" / "src"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

_worker = os.environ.get("PYTEST_XDIST_WORKER", "gw0")
_state = Path(
    tempfile.mkdtemp(prefix=f"scholium-acceptance-reviews-response-{_worker}-")
)
atexit.register(shutil.rmtree, _state, ignore_errors=True)

os.environ["DATABASE_URL"] = f"sqlite:///{_state / 'scholium.db'}"
os.environ["CONTENT_DIR"] = str(_state / "content")
os.environ["NODE_KEY_PATH"] = str(_state / "node.key")
# Background jobs run inline, so anything a commit or a reveal triggers has
# finished -- or failed on its own -- by the time the request returns.
os.environ["JOBS_EAGER"] = "1"
os.environ["RATE_LIMIT_ENABLED"] = "0"
os.environ.setdefault("ORCID_MOCK", "1")
os.environ.setdefault("ARXIV_MOCK", "1")
os.environ.setdefault("AI_PROVIDER", "fake")
os.environ.pop("SCHOLIUM_ENV", None)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


@pytest.fixture
def client():
    """A client that sends no credentials unless a test adds them per request."""
    with TestClient(app) as c:
        yield c

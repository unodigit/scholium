"""Fixtures for the ``GET /v1/papers/{id}/ai-reviews`` acceptance tests
(ai_review plugin, feature 122).

Mirrors the other API acceptance conftests: ``sys.path`` setup plus hermetic,
per-process state chosen
*before* ``app.db`` is imported.  The API's own root ``conftest.py`` does not
apply to tests that live outside ``apps/api``, so the database, content
directory and node key are pointed at a private temporary directory here --
nothing is shared with a developer's local data, with other xdist workers or
with an earlier run of this suite.

``AI_PROVIDER=fake`` is the provider the first criterion names.  ``JOBS_EAGER``
keeps the job runner synchronous, so any follow-on work listing a version
triggers has finished by the time the transition returns; the tests that need
to append the review on purpose suppress that trigger themselves.

Every test builds its own papers with freshly generated Ed25519 authors and
unique titles, so tests never depend on one another's rows.
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
    tempfile.mkdtemp(prefix=f"scholium-acceptance-ai-reviews-{_worker}-")
)
atexit.register(shutil.rmtree, _state, ignore_errors=True)

os.environ["DATABASE_URL"] = f"sqlite:///{_state / 'scholium.db'}"
os.environ["CONTENT_DIR"] = str(_state / "content")
os.environ["NODE_KEY_PATH"] = str(_state / "node.key")
# A node key, so the advisory review the pipeline appends is also signed into
# the event log, exactly as on a provisioned node.  The ledger reads plain hex
# seeds as readily as it reads its own key files.
(_state / "node.key").write_text(os.urandom(32).hex())
os.environ["JOBS_EAGER"] = "1"
os.environ["RATE_LIMIT_ENABLED"] = "0"
os.environ.setdefault("ORCID_MOCK", "1")
os.environ.setdefault("ARXIV_MOCK", "1")
os.environ["AI_PROVIDER"] = "fake"
os.environ.pop("SCHOLIUM_ENV", None)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


@pytest.fixture
def client():
    """An anonymous client: reading a paper and its AI review is public."""
    with TestClient(app) as c:
        yield c

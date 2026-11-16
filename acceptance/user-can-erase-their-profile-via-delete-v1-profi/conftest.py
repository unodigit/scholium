"""Fixtures for the DELETE /v1/profiles/{did} acceptance tests.

Mirrors the other acceptance conftests: sys.path setup plus a per-xdist-worker
SQLite database chosen before ``app.db`` is imported.  ``JOBS_EAGER`` is set so
an implementation that carries the erasure out through the job queue finishes
it inside the DELETE request, as tests need the effect observable right away.
No node key is provisioned: appending to the ledger does not depend on one.
Every test generates its own Ed25519 identity and unique personal data and
record bodies, so nothing is shared between tests, xdist workers or runs of
this suite.
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
# A per-worker database so parallel tests never share (and corrupt) one file.
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


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c

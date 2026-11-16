"""Fixtures for the recovery finalize / cancel acceptance tests.

Mirrors the other acceptance conftests: sys.path setup plus a per-xdist-worker
SQLite database chosen before ``app.db`` is imported.

* ``JOBS_EAGER=1`` keeps the job runner synchronous, so a job that is *due*
  runs inside the call that makes it due.  Jobs deferred with ``run_after``
  are still never run inline; the tests run those through
  ``app.jobs.run_pending()`` once the contest window is over.
* ``ORCID_MOCK=1`` makes ``mock-<orcid>`` authorization codes acceptable, which
  is how an account gets the ORCID link a recovery request is identified by.
* A node signing key is provisioned because the ORCID callback issues a
  node-signed credential, and finalizing a recovery appends a record on the
  node's behalf.

Every test generates its own Ed25519 identities (account, guardians, new key)
and a fresh ORCID iD, so nothing is shared between tests, xdist workers or
runs of this suite -- the SQLite file outlives a run, so reuse would collide
with the one-ORCID-one-DID rule.
"""

import os
import sys
import tempfile
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
os.environ.setdefault("ORCID_MOCK", "1")

# origin.node_did() consults these before the key file; they must not shadow
# key-file resolution for the node-signed credential.
for _name in ("NODE_DID", "ORIGIN_NODE", "SCHOLIUM_NODE_DID"):
    os.environ.pop(_name, None)

from nacl.signing import SigningKey  # noqa: E402

#: This worker's node key: a fresh Ed25519 seed, written as hex text.
NODE_KEY_SEED = bytes(SigningKey.generate())
_KEY_PATH = Path(tempfile.mkdtemp(prefix=f"scholium-acceptance-{worker}-")) / "node.key"
_KEY_PATH.write_bytes(NODE_KEY_SEED.hex().encode("ascii"))
os.environ["NODE_KEY_PATH"] = str(_KEY_PATH)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.settings import settings  # noqa: E402

settings.NODE_KEY_PATH = str(_KEY_PATH)
settings.ORCID_MOCK = 1


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c

"""Fixtures for the GET /v1/auth/orcid/callback acceptance tests.

Mirrors the orcid start and sync-head acceptance conftests: sys.path setup
plus a per-xdist-worker SQLite database chosen before ``app.db`` is
imported.  The callback issues a *node-signed* verifiable credential, so
these fixtures also provision the node Ed25519 key the same way the
sync-head suite does.  ORCID is kept in mock mode (``ORCID_MOCK=1``) so
``mock-<orcid>`` codes are accepted without reaching ORCID.
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
if "PYTEST_XDIST_WORKER" in os.environ:
    os.environ["DATABASE_URL"] = f"sqlite:///./test_{worker}.db"
else:
    os.environ.setdefault("DATABASE_URL", f"sqlite:///./test_{worker}.db")
os.environ.setdefault("JOBS_EAGER", "1")
os.environ.setdefault("ORCID_MOCK", "1")

# origin.node_did() consults these before the key file; they must not
# shadow key-file resolution for the node-signed credential.
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
def node_key_seed() -> bytes:
    """The 32-byte Ed25519 seed this run's ``NODE_KEY_PATH`` file holds."""
    return NODE_KEY_SEED


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c

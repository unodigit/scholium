"""Fixtures for the GET /v1/sync/head acceptance tests.

Mirrors the content plugin's acceptance conftest: sys.path setup plus a
per-xdist-worker SQLite database chosen before ``app.db`` is imported.

Feature 14 must sign the head with the node Ed25519 key loaded from
``NODE_KEY_PATH`` (the same file ``app.modules.ledger.origin`` reads), so
these fixtures also provision that key: a fresh seed is generated into a
private temporary directory and pointed at by the ``NODE_KEY_PATH``
environment variable *and* ``settings.NODE_KEY_PATH`` before anything
imports the application.  Whichever way the endpoint reads the setting --
at import time or per request -- it finds the same key file, and the DID
environment overrides (``NODE_DID`` & co.) are cleared first so key-file
resolution cannot be skipped.
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

# origin.node_did() consults these before the key file; they must not
# shadow key-file resolution for the signed head.
for _name in ("NODE_DID", "ORIGIN_NODE", "SCHOLIUM_NODE_DID"):
    os.environ.pop(_name, None)

from nacl.signing import SigningKey  # noqa: E402

#: This worker's node key: a fresh Ed25519 seed, written as hex text (one
#: of the encodings ``ledger.origin`` accepts) before the app is imported.
NODE_KEY_SEED = bytes(SigningKey.generate())
_KEY_PATH = Path(tempfile.mkdtemp(prefix=f"scholium-acceptance-{worker}-")) / "node.key"
_KEY_PATH.write_bytes(NODE_KEY_SEED.hex().encode("ascii"))
os.environ["NODE_KEY_PATH"] = str(_KEY_PATH)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.settings import settings  # noqa: E402

settings.NODE_KEY_PATH = str(_KEY_PATH)


@pytest.fixture
def node_key_seed() -> bytes:
    """The 32-byte Ed25519 seed this run's ``NODE_KEY_PATH`` file holds."""
    return NODE_KEY_SEED


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c

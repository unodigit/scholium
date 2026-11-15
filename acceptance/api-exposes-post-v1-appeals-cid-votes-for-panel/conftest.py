"""Fixtures for the "POST /v1/appeals/{cid}/votes" acceptance tests (appeals
plugin, feature 76).

Mirrors the other API acceptance conftests: ``sys.path`` setup plus hermetic,
per-process state chosen *before* ``app.db`` is imported.  The API's own root
``conftest.py`` does not apply to tests that live outside ``apps/api``, so the
database, content directory and node key are pointed at a private temporary
directory here -- nothing is shared with a developer's local data, with other
xdist workers or with earlier runs of this suite.

Unlike the sibling suites, this one also *provisions the node's signing key*.
The feature under test makes the node sign an ``appeal.decision``, and the app
never creates its key file (``ledger.node_signing_key()`` is ``None`` for a
missing file), so a key is written to ``NODE_KEY_PATH`` before the app is
imported and its ``did:key`` is exposed as the ``node_did`` fixture: a decision
is node-signed when that DID is its author.
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
_state = Path(tempfile.mkdtemp(prefix=f"scholium-acceptance-appeal-votes-{_worker}-"))
atexit.register(shutil.rmtree, _state, ignore_errors=True)

os.environ["DATABASE_URL"] = f"sqlite:///{_state / 'scholium.db'}"
os.environ["CONTENT_DIR"] = str(_state / "content")
# Background jobs run inline, so any follow-on work a request triggers (an
# author notification, say) has finished -- or failed on its own -- by the time
# the request that caused it returns.
os.environ["JOBS_EAGER"] = "1"
os.environ["RATE_LIMIT_ENABLED"] = "0"
os.environ.setdefault("ORCID_MOCK", "1")
os.environ.setdefault("ARXIV_MOCK", "1")
os.environ.setdefault("AI_PROVIDER", "fake")
os.environ.pop("SCHOLIUM_ENV", None)

# ``origin.node_did()`` consults these before the key file; they must not shadow
# the key this suite provisions.
for _name in ("NODE_DID", "ORIGIN_NODE", "SCHOLIUM_NODE_DID"):
    os.environ.pop(_name, None)

from nacl.signing import SigningKey  # noqa: E402

#: This process's node key: a fresh Ed25519 seed, written as hex text (one of
#: the encodings ``ledger.origin`` accepts) before the app is imported.
_NODE_SEED = bytes(SigningKey.generate())
_KEY_PATH = _state / "node.key"
_KEY_PATH.write_bytes(_NODE_SEED.hex().encode("ascii"))
os.environ["NODE_KEY_PATH"] = str(_KEY_PATH)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from scholium_record_core import did_key_from_signing_key  # noqa: E402

from app.main import app  # noqa: E402
from app.settings import settings  # noqa: E402

# ``settings`` may have been built before the environment above was in place.
settings.NODE_KEY_PATH = str(_KEY_PATH)

_NODE_DID = did_key_from_signing_key(SigningKey(_NODE_SEED))


@pytest.fixture
def client():
    """A client that sends no credentials unless a test adds them per request."""
    with TestClient(app) as c:
        yield c


@pytest.fixture
def node_did() -> str:
    """The ``did:key`` of the key at this run's ``NODE_KEY_PATH``."""
    return _NODE_DID

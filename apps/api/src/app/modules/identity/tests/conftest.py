"""Fixtures for the identity plugin's endpoint tests.

Mirrors the ledger plugin's conftest (and apps/api/tests/conftest.py, which
only applies to that tree): a per-xdist-worker SQLite database and a
TestClient over the real app assembled by the module loader.

Caveat, shared with the ledger and uploads plugins: because this tests
directory is a package (``__init__.py``), pytest imports this file as
``app.modules.identity.tests.conftest``, and importing the parent package
chain binds ``app.db``'s engine before the assignment below runs.  In a
full-suite run the arg-level ``apps/api/tests/conftest.py`` has already set
the per-worker URL by then; in a directory-local run the default
``scholium.db`` backs the engine -- and under the default ``-n 2`` the xdist
workers then share that one file.  The tests are written to tolerate either:
they look challenges up by their (random, unique) nonce, check "nothing was
saved" by looking for rows of the one rejected did (or by asserting the
service was never reached), and never assert on whole-table row counts, which
other workers' inserts would race with.
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
from nacl.signing import SigningKey  # noqa: E402
from scholium_record_core import did_key_from_signing_key  # noqa: E402

from app.main import app  # noqa: E402


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def did() -> str:
    """A fresh, valid Ed25519 did:key."""
    return did_key_from_signing_key(SigningKey.generate())

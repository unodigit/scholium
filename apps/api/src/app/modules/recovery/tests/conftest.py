"""Fixtures for the recovery plugin's tests.

Mirrors the identity plugin's conftest: a per-xdist-worker SQLite database and
a TestClient over the real app assembled by the module loader. See that
conftest for the caveat about directory-local runs sharing one database file;
these tests use freshly generated DIDs throughout and never assert on
whole-table row counts, so they tolerate it.
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
from app.security import issue_access_token  # noqa: E402


def new_did() -> str:
    """A fresh, valid Ed25519 did:key."""
    return did_key_from_signing_key(SigningKey.generate())


def auth(did: str, tier: int = 0) -> dict[str, str]:
    """An ``Authorization`` header carrying an access token for ``did``."""
    return {"Authorization": f"Bearer {issue_access_token(did, tier)}"}


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def did() -> str:
    return new_did()


@pytest.fixture
def five_guardians() -> list[str]:
    return [new_did() for _ in range(5)]

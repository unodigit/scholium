"""Fixtures for the orcid plugin's tests.

Mirrors the imports plugin's conftest: a per-xdist-worker SQLite database, a
TestClient over a freshly assembled app, and a temporary node Ed25519 key so
:func:`app.modules.orcid.service.issue_orcid_credential` can sign credentials.

Each test also gets its own throwaway database.  Issued credentials are rows in
the ``credentials`` table, and the shared per-worker test database persists
between pytest runs; letting those rows accumulate makes an unrelated profiles
test (which inserts a fixed credential id) fail on the second run.  Swapping
``app.db``'s engine for a fresh file per test leaves the shared database as it
was found.
"""

import os
import sys
import uuid
from pathlib import Path

SRC = Path(__file__).resolve().parents[4]
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

worker = os.environ.get("PYTEST_XDIST_WORKER", "gw0")
if "PYTEST_XDIST_WORKER" in os.environ:
    os.environ["DATABASE_URL"] = f"sqlite:///./test_{worker}.db"
else:
    os.environ.setdefault("DATABASE_URL", f"sqlite:///./test_{worker}.db")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from nacl.signing import SigningKey  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from scholium_record_core import did_key_from_signing_key  # noqa: E402

from app import db  # noqa: E402
from app.main import create_app  # noqa: E402
from app.modules.orcid import issue_orcid_credential  # noqa: E402
from app.modules.orcid import models as orcid_models  # noqa: E402
from app.settings import settings  # noqa: E402


@pytest.fixture(autouse=True)
def isolated_database(tmp_path, monkeypatch):
    """Point ``app.db`` at a fresh SQLite file for this test only."""
    engine = create_engine(
        f"sqlite:///{tmp_path / 'orcid-test.db'}",
        connect_args={"check_same_thread": False},
        future=True,
    )
    monkeypatch.setattr(db, "engine", engine)
    monkeypatch.setattr(
        db,
        "SessionLocal",
        sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True),
    )
    # ``ensure_tables`` memoises the engine it created the private table on.
    monkeypatch.setattr(orcid_models, "_table_engine", None)
    yield
    engine.dispose()


@pytest.fixture
def node_key(tmp_path, monkeypatch):
    """A node Ed25519 key at a temporary ``NODE_KEY_PATH``."""
    seed = SigningKey.generate()
    path = tmp_path / "node.key"
    path.write_text(seed.encode().hex())
    monkeypatch.setattr(settings, "NODE_KEY_PATH", str(path))
    return seed


@pytest.fixture
def node_did(node_key) -> str:
    return did_key_from_signing_key(node_key)


@pytest.fixture
def subject_did() -> str:
    """A subject DID unique to this test."""
    return f"did:key:z6Mk{uuid.uuid4().hex}"


@pytest.fixture
def credential(node_key, subject_did, isolated_database) -> dict:
    """A node-signed ORCID ownership credential for ``subject_did``."""
    return issue_orcid_credential(subject_did, "0000-0002-1825-0097")


@pytest.fixture
def client(isolated_database):
    with TestClient(create_app()) as c:
        yield c


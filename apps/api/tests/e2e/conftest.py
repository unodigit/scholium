"""Fixtures for the API journey tests: one fresh, self-contained node per test.

A journey starts from "a new DID" and asserts on what it sees along the way, so
it must not inherit rows from an earlier test or an earlier run (the per-worker
SQLite file the other suites share survives between runs, and an ORCID iD can
be linked only once).  Every test therefore gets its own database file, its own
node signing key and its own empty mailbox, and talks to an app assembled by
``create_app()`` over them.

The node is configured the way a development node is: ORCID in mock mode (a
code of ``mock-<orcid>`` stands for a completed ORCID login), no ``SMTP_URL``
(mail lands in the in-process outbox instead of going out) and eager jobs (jobs
that are due run inline; ones deferred to a later time wait for the test to run
the job runner).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from nacl.signing import SigningKey
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import db
from app.main import create_app
from app.modules.admin.cli import main as admin_cli
from app.modules.notifications import clear_outbox
from app.settings import settings

from .helpers import Actor


@pytest.fixture(autouse=True)
def node(tmp_path, monkeypatch):
    """A hermetic node: fresh database, signing key, mock ORCID and an empty outbox.

    Yields the node's Ed25519 signing key, whose ``did:key`` is the issuer of the
    ORCID credentials this node signs.
    """
    engine = create_engine(
        f"sqlite:///{tmp_path / 'journey.db'}",
        connect_args={"check_same_thread": False},
        future=True,
    )
    monkeypatch.setattr(db, "engine", engine)
    monkeypatch.setattr(
        db,
        "SessionLocal",
        sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True),
    )

    node_key = SigningKey.generate()
    key_file = tmp_path / "node.key"
    key_file.write_text(node_key.encode().hex())
    monkeypatch.setattr(settings, "NODE_KEY_PATH", str(key_file))

    # Long enough that PyJWT does not warn about the HMAC key size.
    monkeypatch.setattr(settings, "JWT_SECRET", "journey-secret-" + "x" * 64)
    monkeypatch.setattr(settings, "ORCID_MOCK", 1)
    monkeypatch.setattr(settings, "SMTP_URL", "")
    # Due jobs run inline, and jobs deferred to a later time wait until a test
    # runs the job runner itself (``jobs.run_pending``): no worker thread is
    # left polling a database file that the next test deletes.
    monkeypatch.setattr(settings, "JOBS_EAGER", 1)

    clear_outbox()
    yield node_key
    clear_outbox()
    engine.dispose()


@pytest.fixture
def client(node):
    """A TestClient over a freshly assembled app, running on the hermetic node."""
    with TestClient(create_app()) as c:
        yield c


@pytest.fixture
def reviewer(client) -> Actor:
    """A signed-in tier-3 Reviewer, the lowest tier that may endorse.

    Nothing on the public API grants tier 3, so the node operator appoints the
    reviewer with the admin command (``python -m app.modules.admin set-tier``)
    after the reviewer's first sign-in; the reviewer's next token carries it.
    """
    actor = Actor(client)
    actor.sign_in()
    assert admin_cli(["set-tier", actor.did, "reviewer"]) == 0
    actor.refresh()
    assert actor.tier == 3
    return actor

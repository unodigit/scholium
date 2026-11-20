"""The ``erasure.request`` a profile erasure appends is signed by the node.

``DELETE /v1/profiles/{did}`` used to append an ``erasure.request`` authored by
the member with ``"proofs": []`` and no ``sig``: the member signed nothing, so
the node's own export failed ``scholium verify`` ("has no signature") and
``scholium rebuild`` refused to write a database.

Per D1 the erasure is now recorded by the node: the record is authored and
signed by the node's ``did:key`` (the key every other node-issued record uses)
and names the member in ``body.subject``.  A node with no signing key still
shreds the profile and still answers 202, but appends nothing rather than an
unsigned record.  A profile whose row is gone reads as erased from either form
of record: the new one (node-authored, ``body.subject`` is the DID) and the
legacy one (``author`` is the DID).

The last test is the symptom itself: it erases a profile on an isolated node,
exports the node and runs the two documented commands over the bytes the API
served.  It runs the API in a child process with its own database and node key
because the event log is append-only and shared by every test in an xdist
worker; an in-process export would carry records other tests appended.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

import dag_cbor
import pytest
from nacl.signing import SigningKey
from scholium_cli.archive import load_archive
from scholium_cli.car import read_car
from scholium_cli.main import main as scholium
from scholium_record_core import (
    did_key_from_signing_key,
    sign_record,
    verify_record,
)
from scholium_record_core.verify import record_problem
from sqlalchemy import text

from app import db
from app.modules import ledger
from app.modules.ledger.models import EventLog
from app.modules.profiles import read_profile

PROFILE = {
    "name": "Ada Lovelace",
    "affiliation": "Analytical Engine Co.",
    "email": "ada@example.org",
}

ERASURE = "erasure.request"
NODE_KEY_SEED = bytes(range(32))

#: The API's workspace root (``apps/api``), the directory ``uv run`` uses.
API_ROOT = Path(__file__).resolve().parents[5]


@pytest.fixture
def node_key(monkeypatch, tmp_path) -> SigningKey:
    """Provision a node Ed25519 key (hex seed file) at ``NODE_KEY_PATH``."""
    key_path = tmp_path / "node.key"
    key_path.write_text(NODE_KEY_SEED.hex())
    monkeypatch.setattr("app.modules.ledger.origin.settings.NODE_KEY_PATH", str(key_path))
    return SigningKey(NODE_KEY_SEED)


@pytest.fixture
def no_node_key(monkeypatch, tmp_path) -> None:
    """Point ``NODE_KEY_PATH`` at a file that does not exist."""
    monkeypatch.setattr(
        "app.modules.ledger.origin.settings.NODE_KEY_PATH", str(tmp_path / "missing.key")
    )


def _erasure_entries() -> list[EventLog]:
    return [entry for entry in ledger.entries() if entry.record_type == ERASURE]


def _naming(did: str) -> list[EventLog]:
    """The ``erasure.request`` rows that name ``did``, in either form."""
    return [
        entry
        for entry in _erasure_entries()
        if entry.author_did == did or (entry.body or {}).get("subject") == did
    ]


def _stored_record(entry: EventLog) -> dict[str, Any]:
    """The record as an export carries it: the signed content, ``id`` and ``sig``."""
    record = dict(dag_cbor.decode(bytes(entry.raw)))
    record["id"] = entry.record_cid
    if entry.sig is not None:
        record["sig"] = entry.sig
    return record


def _erase(client, auth, did: str) -> None:
    assert client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did)).status_code == 200
    assert client.delete(f"/v1/profiles/{did}", headers=auth(did)).status_code == 202


def _drop_profile_row(did: str) -> None:
    with db.engine.begin() as conn:
        conn.execute(text("DELETE FROM profile WHERE did = :did"), {"did": did})


def _node_erasure(key: SigningKey, subject: str, *, author_key: SigningKey | None = None) -> dict:
    """A signed node-form ``erasure.request`` naming ``subject``."""
    signer = author_key or key
    return sign_record(
        {
            "v": 1,
            "type": ERASURE,
            "author": did_key_from_signing_key(signer),
            "created": "2026-11-15T00:00:00Z",
            "prev": None,
            "body": {"subject": subject, "basis": "data-subject-request"},
            "proofs": [],
        },
        signer,
    )


def _legacy_erasure(did: str) -> None:
    """The record the old route appended: authored by the member, unsigned."""
    ledger.append(
        {
            "v": 1,
            "type": ERASURE,
            "author": did,
            "created": "2026-11-15T00:00:00Z",
            "prev": None,
            "body": {"basis": "data-subject-request"},
            "proofs": [],
        }
    )


def _erased_view(client, did: str) -> dict:
    return client.get(f"/v1/profiles/{did}").json()


# --- the appended record -----------------------------------------------------


def test_the_erasure_record_authenticates_with_the_record_core_verifier(
    client, did, auth, node_key
):
    _erase(client, auth, did)

    (entry,) = _naming(did)
    record = _stored_record(entry)

    assert "sig" in record, "the appended erasure.request carries no signature"
    assert record_problem(record) is None
    assert verify_record(record) is True


def test_the_erasure_record_is_authored_by_the_node_and_names_the_member(
    client, did, auth, node_key
):
    _erase(client, auth, did)

    (entry,) = _naming(did)
    record = _stored_record(entry)

    assert record["author"] == did_key_from_signing_key(node_key)
    assert record["author"] != did
    assert record["body"] == {"subject": did, "basis": "data-subject-request"}
    assert record["proofs"] == []
    assert entry.author_did == did_key_from_signing_key(node_key)


# --- the profile reads erased afterwards --------------------------------------


def test_the_profile_reads_erased_after_the_route_runs(client, did, auth, node_key):
    _erase(client, auth, did)

    body = _erased_view(client, did)

    assert body["erased"] is True
    assert body["name"] is None
    assert body["affiliation"] is None
    assert body["email"] is None
    assert read_profile(did) is None


def test_the_new_form_reads_erased_even_when_the_profile_row_is_gone(client, did, auth, node_key):
    _erase(client, auth, did)
    _drop_profile_row(did)

    assert _erased_view(client, did)["erased"] is True


def test_the_legacy_form_still_reads_erased_when_the_profile_row_is_gone(client, did, auth):
    """Records the old route already appended (author is the member) still count."""
    assert client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did)).status_code == 200
    _legacy_erasure(did)
    _drop_profile_row(did)

    assert _erased_view(client, did)["erased"] is True


def test_a_record_naming_the_member_that_the_node_did_not_author_erases_nothing(
    client, did, auth, node_key
):
    """Anyone can sign a record; only the node's, or the member's own, erases."""
    assert client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did)).status_code == 200
    ledger.append(_node_erasure(node_key, did, author_key=SigningKey.generate()))
    _drop_profile_row(did)

    assert _erased_view(client, did)["erased"] is False


def test_a_node_erasure_naming_someone_else_erases_nothing(client, did, auth, node_key):
    other = f"did:key:z6Mk{uuid.uuid4().hex}"
    ledger.append(_node_erasure(node_key, other))

    assert _erased_view(client, did)["erased"] is False


# --- a node with no signing key -------------------------------------------------


def test_without_a_node_key_the_erasure_still_shreds_and_answers_202_but_appends_nothing(
    client, did, auth, no_node_key, caplog
):
    with caplog.at_level(logging.WARNING, logger="app.modules.profiles.service"):
        _erase(client, auth, did)

    assert _naming(did) == [], "an unsigned erasure.request was appended"
    assert read_profile(did) is None
    body = _erased_view(client, did)
    assert body["erased"] is True
    assert body["name"] is None
    assert any(
        record.levelno >= logging.WARNING and "signing key" in record.getMessage()
        for record in caplog.records
    ), "the missing record is not logged"


# --- the symptom: the node's own export --------------------------------------------

#: What the child process runs: a listed paper, one member who saves a profile
#: and then erases it through the API, then the whole-node export.
ERASE_AND_EXPORT = """
import json
import sys
from pathlib import Path

from fastapi.testclient import TestClient
from nacl.signing import SigningKey

from app.main import create_app
from app.modules import ledger
from app.modules.export.tests.test_paper_car import build_paper
from app.modules.submissions import LISTED
from app.security import issue_access_token
from scholium_record_core import did_key_from_signing_key, sign_record

member = sys.argv[2]
headers = {"Authorization": "Bearer " + issue_access_token(member, 0)}

with TestClient(create_app()) as client:
    listed = build_paper(state=LISTED)
    listed.append(
        listed.sign(
            "coauthor.consent",
            {
                "version": listed.version["id"],
                "role": "author",
                "decision": "accept",
            },
        )
    )
    moderator_key = SigningKey.generate()
    ledger.append(
        sign_record(
            {
                "v": 1,
                "type": "moderation.decision",
                "author": did_key_from_signing_key(moderator_key),
                "created": "2026-11-15T09:00:03Z",
                "prev": None,
                "body": {
                    "target": listed.version["id"],
                    "action": "list",
                    "clause": "MOD-01",
                    "reason": "In scope and scholarly form.",
                },
                "proofs": [],
            },
            moderator_key,
        )
    )
    saved = client.put(
        "/v1/profiles/" + member,
        json={"name": "Ada", "affiliation": "Engine Co.", "email": "ada@example.org"},
        headers=headers,
    )
    assert saved.status_code == 200, saved.text
    erased = client.delete("/v1/profiles/" + member, headers=headers)
    assert erased.status_code == 202, erased.text
    response = client.get("/v1/export/archive.car")
    if response.status_code != 200:
        print(f"archive export failed: {response.status_code} {response.text}", file=sys.stderr)
        raise SystemExit(1)
    Path(sys.argv[1]).write_bytes(response.content)
"""


def _export_after_an_erasure(tmp_path: Path) -> Path:
    """Run ``ERASE_AND_EXPORT`` in a fresh process; return the archive it wrote."""
    key_path = tmp_path / "node.key"
    key_path.write_text(NODE_KEY_SEED.hex())
    script = tmp_path / "erase_and_export.py"
    script.write_text(ERASE_AND_EXPORT)
    archive = tmp_path / "archive.car"

    env = dict(os.environ)
    env.pop("TEST_DATABASE_URL", None)
    env.pop("SCHOLIUM_ENV", None)
    env.update(
        {
            "DATABASE_URL": f"sqlite:///{tmp_path / 'node.db'}",
            "CONTENT_DIR": str(tmp_path / "content"),
            "NODE_KEY_PATH": str(key_path),
            "STORAGE_BACKEND": "fs",
            "JOBS_EAGER": "1",
            "RATE_LIMIT_ENABLED": "0",
            "AI_PROVIDER": "fake",
            "ORCID_MOCK": "1",
            "ARXIV_MOCK": "1",
            "PYTHONPATH": os.pathsep.join(
                [
                    str(API_ROOT / "src"),
                    str(API_ROOT / "packages" / "record-core" / "src"),
                    str(API_ROOT / "packages" / "cli" / "src"),
                ]
            ),
        }
    )
    member = f"did:key:z6Mk{uuid.uuid4().hex}"
    completed = subprocess.run(
        [sys.executable, str(script), str(archive), member],
        cwd=API_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    return archive


def test_an_export_taken_after_an_erasure_passes_verify_and_rebuild(tmp_path, capsys):
    archive = _export_after_an_erasure(tmp_path)

    verified = scholium(["verify", str(archive)])
    out = capsys.readouterr().out
    assert verified == 0, out
    assert "failed authentication" not in out
    assert "NOT VERIFIED" not in out

    database = tmp_path / "rebuilt.db"
    rebuilt = scholium(["rebuild", str(archive), "--db", str(database)])
    out = capsys.readouterr().out
    assert rebuilt == 0, out
    assert "NOT REBUILT" not in out
    assert database.exists()


def test_the_exported_log_carries_the_erasure_record(tmp_path):
    """Guards the test above: the export it checks really includes an erasure."""
    archive = _export_after_an_erasure(tmp_path)

    loaded = load_archive(read_car(archive.read_bytes()))
    erasures = [record for record in loaded.records if record.get("type") == ERASURE]

    assert len(erasures) == 1
    assert verify_record(erasures[0]) is True
    assert erasures[0]["body"]["basis"] == "data-subject-request"

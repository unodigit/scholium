"""Regression: a hidden post/annotation/review decision can be appealed."""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from nacl.signing import SigningKey

from app import db
from app.main import app
from app.modules import ledger, moderation
from app.modules.moderation.tests.test_decisions import (
    DECISIONS_URL,
    RECORDS_URL,
    Moderator,
    Submission,
    _timestamp,
)
from app.modules.moderation.tests.test_record_decisions import RecordAuthor, _post
from app.security import issue_access_token
from app.settings import settings

APPEALS_URL = "/v1/appeals"


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def subscribed():
    moderation._install_ledger_subscriber()
    from app.modules import appeals

    appeals._install_ledger_subscriber()


@pytest.fixture(autouse=True)
def node_key(tmp_path, monkeypatch):
    path = tmp_path / "node.key"
    path.write_bytes(bytes(SigningKey.generate()).hex().encode("ascii"))
    monkeypatch.setattr(settings, "NODE_KEY_PATH", str(path))
    return path


def test_appeal_on_hidden_post_decision_is_accepted(client):
    submission = Submission()
    author = RecordAuthor()
    post_record = _post(author, submission)
    post_cid = post_record["id"]

    moderator = Moderator()
    decision = moderator.decide.__wrapped__ if hasattr(moderator.decide, "__wrapped__") else None
    # build a hide decision manually
    decision_record = {
        "v": 1,
        "type": moderation.DECISION_TYPE,
        "author": moderator.did,
        "created": _timestamp(),
        "prev": None,
        "body": {
            "target": post_cid,
            "action": "hide",
            "clause": "MOD-01",
            "reason": "Abusive.",
        },
        "proofs": [],
    }
    from scholium_record_core import sign_record, verify_record

    signed = sign_record(decision_record, moderator.seed)
    assert verify_record(signed)
    response = client.post(DECISIONS_URL, json=signed, headers=moderator.headers)
    assert response.status_code == 201, response.text

    decision_cid = signed["id"]

    appeal_record = {
        "v": 1,
        "type": "appeal",
        "author": author.did,
        "created": _timestamp(),
        "prev": None,
        "body": {
            "target": decision_cid,
            "grounds": "unfair",
            "paper": submission.paper_cid,
        },
        "proofs": [],
    }
    from scholium_record_core import sign_record as _sign

    signed_appeal = _sign(appeal_record, author.seed)
    assert verify_record(signed_appeal)

    appellant_headers = {"Authorization": f"Bearer {issue_access_token(author.did, 1)}"}
    response = client.post(APPEALS_URL, json=signed_appeal, headers=appellant_headers)
    assert response.status_code == 201, response.text

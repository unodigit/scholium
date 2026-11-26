"""Regression tests: a hidden annotation's author reads their own text.

Per D1, the annotations reads accept an optional signed-in viewer.  For the
viewer's own hidden annotation the placeholder carries ``own_text`` /
``ownText`` and ``is_own`` / ``isOwn``; other readers get today's placeholder.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

import pytest
from nacl.signing import SigningKey
from scholium_record_core import derive_short_id, did_key_from_signing_key, sign_record

from app import db
from app.modules import annotations, ledger, moderation
from app.modules.identity.models import Account, ensure_account_table
from app.security import issue_access_token


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Signer:
    def __init__(self, tier: int = 0) -> None:
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self.headers = {"Authorization": f"Bearer {issue_access_token(self.did, tier)}"}
        if tier > 0:
            ensure_account_table()
            with db.SessionLocal() as session:
                session.add(
                    Account(
                        did=self.did,
                        tier=tier,
                        created_at=datetime.now(timezone.utc).replace(tzinfo=None),
                    )
                )
                session.commit()

    def sign(self, record_type: str, body: dict, prev: Optional[str] = None) -> dict:
        return sign_record(
            {
                "v": 1,
                "type": record_type,
                "author": self.did,
                "created": _now(),
                "prev": prev,
                "body": body,
                "proofs": [],
            },
            self.seed,
        )


def _publish(author: Signer) -> tuple[str, str]:
    tag = uuid.uuid4().hex
    genesis = author.sign(
        "paper.genesis",
        {
            "seed": tag,
            "title": f"Annotated paper {tag}",
            "abstract": "A paper people annotate.",
            "categories": ["cs.CR"],
            "licence": "CC-BY-4.0",
            "authors": [author.did],
        },
    )
    ledger.append(genesis)
    version = author.sign(
        "paper.version",
        {
            "paper": genesis["id"],
            "n": 1,
            "title": f"Annotated paper {tag}",
            "abstract": "A paper people annotate.",
            "authors": [author.did],
            "manifest": "bafyreifakemanifestcid",
            "licence": "CC-BY-4.0",
            "changeNote": "Version 1.",
        },
        prev=genesis["id"],
    )
    ledger.append(version)
    return derive_short_id(genesis["id"]), version["id"]


def _annotate(author: Signer, version_cid: str, text: str) -> str:
    record = author.sign(
        "discussion.post",
        {
            "target": version_cid,
            "anchor": {
                "version": version_cid,
                "paragraph_id": "p-1",
                "quote": "the quoted words",
                "offset": 4,
            },
            "text": text,
        },
    )
    ledger.append(record)
    return record["id"]


@pytest.fixture
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        yield c


def test_author_sees_own_text_and_no_store(client):
    author = Signer(tier=1)
    moderator = Signer(tier=4)
    short_id, version_cid = _publish(author)
    text = f"the hidden annotation {uuid.uuid4().hex}"
    record_id = _annotate(author, version_cid, text)
    decision = moderator.sign(
        "moderation.decision",
        {"target": record_id, "action": "hide", "clause": "MOD-01", "reason": "Abusive."},
    )
    ledger.append(decision)
    moderation.hide_target(record_id, decision["id"])

    response = client.get(f"/v1/papers/{short_id}/v/1/annotations", headers=author.headers)
    assert response.status_code == 200
    item = response.json()["annotations"]["p-1"][0]
    assert item["hidden"] is True
    assert item["own_text"] == text
    assert item["ownText"] == text
    assert item["is_own"] is True
    assert item["isOwn"] is True
    assert item["text"] is None
    assert response.headers["cache-control"] == "private, no-store"


def test_another_member_sees_no_text(client):
    author = Signer(tier=1)
    other = Signer(tier=1)
    moderator = Signer(tier=4)
    short_id, version_cid = _publish(author)
    text = f"the hidden annotation {uuid.uuid4().hex}"
    record_id = _annotate(author, version_cid, text)
    decision = moderator.sign(
        "moderation.decision",
        {"target": record_id, "action": "hide", "clause": "MOD-01", "reason": "Abusive."},
    )
    ledger.append(decision)
    moderation.hide_target(record_id, decision["id"])

    response = client.get(f"/v1/papers/{short_id}/v/1/annotations", headers=other.headers)
    assert response.status_code == 200
    item = response.json()["annotations"]["p-1"][0]
    assert item["hidden"] is True
    assert "own_text" not in item
    assert "is_own" not in item
    assert item["text"] is None


def test_anonymous_reader_sees_no_text(client):
    author = Signer(tier=1)
    moderator = Signer(tier=4)
    short_id, version_cid = _publish(author)
    text = f"the hidden annotation {uuid.uuid4().hex}"
    record_id = _annotate(author, version_cid, text)
    decision = moderator.sign(
        "moderation.decision",
        {"target": record_id, "action": "hide", "clause": "MOD-01", "reason": "Abusive."},
    )
    ledger.append(decision)
    moderation.hide_target(record_id, decision["id"])

    response = client.get(f"/v1/papers/{short_id}/v/1/annotations")
    assert response.status_code == 200
    item = response.json()["annotations"]["p-1"][0]
    assert item["hidden"] is True
    assert "own_text" not in item
    assert "is_own" not in item
    assert item["text"] is None


def test_visible_annotation_unchanged_for_everyone(client):
    author = Signer(tier=1)
    other = Signer(tier=1)
    short_id, version_cid = _publish(author)
    text = f"a visible annotation {uuid.uuid4().hex}"
    record_id = _annotate(author, version_cid, text)

    for headers in (None, author.headers, other.headers):
        kwargs = {"headers": headers} if headers else {}
        response = client.get(f"/v1/papers/{short_id}/v/1/annotations", **kwargs)
        assert response.status_code == 200
        item = response.json()["annotations"]["p-1"][0]
        assert item["id"] == record_id
        assert item["text"] == text
        assert "own_text" not in item
        assert "is_own" not in item
        assert "hidden" not in item or item.get("hidden") is not True


def test_service_viewer_did_keyword_and_positional():
    # ensure service signature flexibility
    from app.modules.annotations.service import annotations_for_version

    author = Signer(tier=1)
    moderator = Signer(tier=4)
    short_id, version_cid = _publish(author)
    text = f"svc hidden {uuid.uuid4().hex}"
    record_id = _annotate(author, version_cid, text)
    decision = moderator.sign(
        "moderation.decision",
        {"target": record_id, "action": "hide", "clause": "MOD-01", "reason": "Abusive."},
    )
    ledger.append(decision)
    moderation.hide_target(record_id, decision["id"])

    # keyword viewer_did
    groups = annotations_for_version(version_cid, viewer_did=author.did)
    assert groups["p-1"][0]["own_text"] == text
    # positional viewer_did (second positional)
    groups2 = annotations_for_version(version_cid, author.did)
    assert groups2["p-1"][0]["is_own"] is True
    # viewer object
    class V:
        did = author.did
    groups3 = annotations_for_version(version_cid, viewer=V())
    assert groups3["p-1"][0]["own_text"] == text
    # anonymous
    groups4 = annotations_for_version(version_cid)
    assert "own_text" not in groups4["p-1"][0]
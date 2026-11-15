"""Tests for the ``review_escrows`` escrow (plugin: reviews, feature 108).

A committed review is pseudonymous, so the only thing that can name its
reviewer is the access token of the caller.  These tests commit through the
real endpoint and then inspect the row the plugin wrote: the identity must be
a sealed box that opens with the committee's private key, the table must have
no plaintext DID, and the HMAC token must enforce one review per person and
paper independently of the client-supplied nullifier.

The paper and reviewer fixtures come from the sibling feature-107 suite; the
escrow assertions are this suite's own.  Isolation note: the test database is
shared by every test in a worker, so each test generates its own keys, DIDs
and paper cids.
"""

from __future__ import annotations

import base64
import secrets
import uuid

import pytest
from fastapi.testclient import TestClient
from nacl.public import PrivateKey
from sqlalchemy import inspect
from sqlalchemy.exc import IntegrityError

from app import db
from app.main import app
from app.modules.reviews import (
    CommitteeKeyError,
    ReviewEscrow,
    escrow_review,
    get_escrow,
    get_review,
    open_identity,
    save_review_escrow,
    seal_identity,
    uniqueness_token,
)
from app.modules.reviews.escrow import _development_committee_secret_key
from app.settings import settings

from .test_review_commit import COMMIT_URL, Paper, Reviewer, _sign

client = TestClient(app)


@pytest.fixture
def committee_key(monkeypatch) -> PrivateKey:
    """Configure a fresh committee key pair for the duration of one test."""
    key = PrivateKey.generate()
    monkeypatch.setattr(
        settings,
        "COMMITTEE_PUBLIC_KEY",
        base64.b64encode(bytes(key.public_key)).decode("ascii"),
    )
    return key


def _post(reviewer: Reviewer, record: dict):
    return client.post(COMMIT_URL, json=record, headers=reviewer.headers)


def _count_tokens(token: str) -> int:
    with db.SessionLocal() as session:
        return (
            session.query(ReviewEscrow)
            .filter(ReviewEscrow.uniqueness_token == token)
            .count()
        )


def test_a_commit_escrows_the_reviewer_identity_as_a_sealed_box(committee_key):
    reviewer, paper = Reviewer(), Paper()
    record = reviewer.commit(paper)

    response = _post(reviewer, record)

    assert response.status_code == 201, response.text
    row = get_escrow(record["id"])
    assert row is not None
    assert row.review_cid == record["id"]
    # The stored bytes are ciphertext, not the DID or a reversible encoding.
    assert bytes(row.sealed_identity) != reviewer.did.encode()
    assert reviewer.did.encode() not in bytes(row.sealed_identity)
    # Only the committee's private key opens it, and it opens to the caller.
    assert open_identity(row.sealed_identity, committee_key) == reviewer.did
    # The commit's pseudonymous author is not what was escrowed.
    assert record["body"]["reviewKey"] != reviewer.did


def test_the_escrow_table_has_no_plaintext_reviewer_column(committee_key):
    reviewer, paper = Reviewer(), Paper()
    record = reviewer.commit(paper)
    assert _post(reviewer, record).status_code == 201

    columns = {column.name for column in inspect(ReviewEscrow.__table__).columns}
    assert columns == {"review_cid", "sealed_identity", "uniqueness_token"}

    with db.SessionLocal() as session:
        row = session.get(ReviewEscrow, record["id"])
        stored = "".join(str(getattr(row, name)) for name in columns)
    assert reviewer.did not in stored


def test_the_uniqueness_token_is_stable_and_scoped_to_person_and_paper():
    did_a = f"did:example:{uuid.uuid4().hex}"
    did_b = f"did:example:{uuid.uuid4().hex}"
    paper_a = f"bafyrei{uuid.uuid4().hex}"
    paper_b = f"bafyrei{uuid.uuid4().hex}"

    token = uniqueness_token(did_a, paper_a)

    assert len(token) == 64
    assert token == uniqueness_token(did_a, paper_a)
    assert token != uniqueness_token(did_a, paper_b)
    assert token != uniqueness_token(did_b, paper_a)
    assert did_a not in token and paper_a not in token


def test_the_stored_token_is_the_hmac_for_the_caller_and_paper(committee_key):
    reviewer, paper = Reviewer(), Paper()
    record = reviewer.commit(paper)

    assert _post(reviewer, record).status_code == 201

    row = get_escrow(record["id"])
    assert row.uniqueness_token == uniqueness_token(reviewer.did, paper.paper_cid)
    assert _count_tokens(row.uniqueness_token) == 1


def test_a_second_review_with_a_fresh_nullifier_is_still_a_conflict(committee_key):
    reviewer, paper = Reviewer(), Paper()
    assert reviewer.post_commit(paper).status_code == 201

    # The same person re-commits with a brand-new nullifier.  The nullifier
    # check cannot see that this is the same reviewer; the escrow token can.
    body = dict(reviewer.commit(paper)["body"])
    body["nullifier"] = secrets.token_hex(32)
    second = _sign(reviewer._review_key(paper), "review.commit", body)

    response = _post(reviewer, second)

    assert response.status_code == 409, response.text
    # Nothing from the refused attempt reached the projections.
    assert get_review(second["id"]) is None
    assert _count_tokens(uniqueness_token(reviewer.did, paper.paper_cid)) == 1


def test_the_same_reviewer_may_escrow_reviews_on_two_papers(committee_key):
    reviewer = Reviewer()
    first_paper, second_paper = Paper(), Paper()
    first, second = reviewer.commit(first_paper), reviewer.commit(second_paper)

    assert _post(reviewer, first).status_code == 201
    assert _post(reviewer, second).status_code == 201

    first_escrow = get_escrow(first["id"])
    second_escrow = get_escrow(second["id"])
    assert first_escrow is not None and second_escrow is not None
    assert first_escrow.uniqueness_token != second_escrow.uniqueness_token
    assert open_identity(first_escrow.sealed_identity, committee_key) == reviewer.did
    assert open_identity(second_escrow.sealed_identity, committee_key) == reviewer.did


def test_saving_the_same_escrow_twice_keeps_one_row(committee_key):
    reviewer, paper = Reviewer(), Paper()
    record = reviewer.commit(paper)
    assert _post(reviewer, record).status_code == 201

    again = save_review_escrow(
        review_cid=record["id"],
        reviewer_did=reviewer.did,
        paper_cid=paper.paper_cid,
    )

    assert again.review_cid == record["id"]
    assert _count_tokens(uniqueness_token(reviewer.did, paper.paper_cid)) == 1


def test_the_database_refuses_a_duplicate_uniqueness_token(committee_key):
    reviewer, paper = Reviewer(), Paper()
    record = reviewer.commit(paper)
    assert _post(reviewer, record).status_code == 201
    saved = get_escrow(record["id"])

    with db.SessionLocal() as session:
        session.add(
            ReviewEscrow(
                review_cid=f"other-{uuid.uuid4().hex}",
                sealed_identity=b"sealed",
                uniqueness_token=saved.uniqueness_token,
            )
        )
        with pytest.raises(IntegrityError):
            session.commit()


def test_escrows_open_with_the_derived_development_key(monkeypatch):
    monkeypatch.setattr(settings, "COMMITTEE_PUBLIC_KEY", "")
    monkeypatch.setattr(settings, "SCHOLIUM_ENV", "dev")
    reviewer, paper = Reviewer(), Paper()
    record = reviewer.commit(paper)

    assert _post(reviewer, record).status_code == 201

    row = get_escrow(record["id"])
    development_key = _development_committee_secret_key()
    assert open_identity(row.sealed_identity, development_key) == reviewer.did


def test_a_hex_committee_key_is_accepted(monkeypatch):
    key = PrivateKey.generate()
    monkeypatch.setattr(settings, "COMMITTEE_PUBLIC_KEY", bytes(key.public_key).hex())

    sealed = seal_identity("did:example:hex-key")

    assert open_identity(sealed, key) == "did:example:hex-key"


def test_production_refuses_to_seal_without_a_committee_key(monkeypatch):
    monkeypatch.setattr(settings, "COMMITTEE_PUBLIC_KEY", "")
    monkeypatch.setattr(settings, "SCHOLIUM_ENV", "production")

    with pytest.raises(CommitteeKeyError):
        seal_identity("did:example:someone")


def test_the_alias_writes_the_same_row(committee_key):
    reviewer, paper = Reviewer(), Paper()
    record = reviewer.commit(paper)
    assert _post(reviewer, record).status_code == 201

    row = escrow_review(
        review_cid=record["id"],
        reviewer_did=reviewer.did,
        paper_cid=paper.paper_cid,
    )

    assert row.review_cid == record["id"]

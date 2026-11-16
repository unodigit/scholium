"""Tests for signing a formal review with a name (plugin: reviews, feature 111).

A ``review.formal`` whose body says ``"signed": true`` takes public credit: the
authenticated caller's DID is written to ``review.signed_by``, and
``GET /v1/profiles/{did}/reviews`` -- and the ``reviews`` member of
``GET /v1/profiles/{did}`` -- serves the review once it is revealed.

The paper, the reviewer and the commit/reveal helpers are the ones
``test_review_reveal`` builds, and every test makes its own keys, DIDs and
paper, so nothing is shared through the worker's database.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.modules import reviews
from app.modules.reviews import get_review
from app.modules.reviews.errors import REVIEW_SIGNATURE_NOT_AUTHORIZED
from app.modules.reviews.route_guard import REVIEW_RECORD_ROUTE
from app.modules.reviews.tests.test_review_reveal import (
    RECORDS_URL,
    REVEAL_URL,
    REVEAL_TYPE,
    Paper,
    Reviewer,
    _error_types,
    _problem_type,
    _sign,
    _still_sealed,
)
from app.modules.reviews.tests.test_review_update import (
    publish_version,
    revealed_review,
    update_body,
)

client = TestClient(app)


@pytest.fixture(autouse=True)
def subscribed():
    """Put the package's ledger subscriptions back (other suites clear them)."""
    reviews._install_ledger_subscriber()


def _signed_body(reviewer: Reviewer, paper: Paper) -> dict:
    """A complete rubric that asks for public credit."""
    body = reviewer.rubric(paper)
    body["signed"] = True
    return body


def _profile_reviews(did: str) -> list:
    return client.get(f"/v1/profiles/{did}/reviews").json()["reviews"]


# --------------------------------------------------------------------------- #
# Accepted
# --------------------------------------------------------------------------- #


def test_a_signed_reveal_is_credited_to_the_reviewer():
    reviewer, paper = Reviewer(), Paper()
    body = _signed_body(reviewer, paper)
    commit = reviewer.post_commit(paper, body)

    response = reviewer.post_reveal(paper, body)

    assert response.status_code == 201, response.text
    row = get_review(commit["id"])
    assert row.signed_by == reviewer.did
    assert row.revealed_at is not None


def test_the_profile_reviews_route_lists_the_signed_review():
    reviewer, paper = Reviewer(), Paper()
    body = _signed_body(reviewer, paper)
    commit = reviewer.post_commit(paper, body)
    assert reviewer.post_reveal(paper, body).status_code == 201

    response = client.get(f"/v1/profiles/{reviewer.did}/reviews")

    assert response.status_code == 200, response.text
    answer = response.json()
    assert answer["did"] == reviewer.did
    assert answer["count"] == 1
    assert [review["review_cid"] for review in answer["reviews"]] == [commit["id"]]
    listed = answer["reviews"][0]
    assert listed["version_cid"] == paper.version_cid
    assert listed["recommendation"] == "minor_revisions"
    assert listed["scores"] == body["scores"]


def test_the_profile_view_carries_the_signed_review():
    reviewer, paper = Reviewer(), Paper()
    body = _signed_body(reviewer, paper)
    commit = reviewer.post_commit(paper, body)
    assert reviewer.post_reveal(paper, body).status_code == 201

    profile = client.get(f"/v1/profiles/{reviewer.did}").json()

    assert [review["review_cid"] for review in profile["reviews"]] == [commit["id"]]


def test_an_unsigned_reveal_stays_anonymous():
    reviewer, paper = Reviewer(), Paper()
    body = reviewer.rubric(paper)
    commit = reviewer.post_commit(paper, body)

    assert reviewer.post_reveal(paper, body).status_code == 201

    assert get_review(commit["id"]).signed_by is None
    assert _profile_reviews(reviewer.did) == []


def test_the_reveal_answer_names_the_public_signature():
    reviewer, paper = Reviewer(), Paper()
    body = _signed_body(reviewer, paper)
    reviewer.post_commit(paper, body)

    response = reviewer.post_reveal(paper, body)

    assert response.status_code == 201, response.text
    answer = response.json()
    assert answer["signed"] is True
    assert answer["signed_by"] == reviewer.did


def test_an_anonymous_review_may_be_signed_on_a_later_update():
    reviewer, paper = Reviewer(), Paper()
    commit, formal = revealed_review(reviewer, paper)
    assert get_review(commit["id"]).signed_by is None
    target = publish_version(paper, 2)
    body = {**update_body(reviewer, paper, target), "signed": True}
    record = _sign(reviewer.review_key(paper), REVEAL_TYPE, body, prev=formal["id"])

    response = client.post(REVEAL_URL, json=record, headers=reviewer.headers)

    assert response.status_code == 201, response.text
    assert get_review(commit["id"]).signed_by == reviewer.did
    assert [review["review_cid"] for review in _profile_reviews(reviewer.did)] == [
        commit["id"]
    ]


def test_an_unknown_did_has_no_signed_reviews():
    response = client.get("/v1/profiles/did:key:zNoSuchMember/reviews")

    assert response.status_code == 200
    assert response.json() == {"did": "did:key:zNoSuchMember", "count": 0, "reviews": []}


# --------------------------------------------------------------------------- #
# Refused
# --------------------------------------------------------------------------- #


def test_a_signed_review_by_someone_else_is_refused_and_writes_nothing():
    reviewer, paper = Reviewer(), Paper()
    body = _signed_body(reviewer, paper)
    commit = reviewer.post_commit(paper, body)
    stranger = Reviewer()
    record = reviewer.reveal_record(paper, body)

    response = client.post(REVEAL_URL, json=record, headers=stranger.headers)

    assert response.status_code == 403, response.text
    assert _problem_type(response) == REVIEW_SIGNATURE_NOT_AUTHORIZED
    # Refused before the append, so the review is still sealed and the record
    # never reached the log.
    assert _still_sealed(commit)
    assert get_review(commit["id"]).signed_by is None
    assert client.get(f"/v1/records/{record['id']}").status_code == 404
    assert _profile_reviews(stranger.did) == []


def test_the_signed_flag_must_be_a_boolean():
    reviewer, paper = Reviewer(), Paper()
    body = reviewer.rubric(paper)
    body["signed"] = "yes"
    commit = reviewer.post_commit(paper, {**body, "signed": True})

    response = client.post(
        REVEAL_URL, json=reviewer.reveal_record(paper, body), headers=reviewer.headers
    )

    assert response.status_code == 422, response.text
    assert "invalid_signed" in _error_types(response)
    assert _still_sealed(commit)


def test_a_signed_review_through_the_records_route_is_refused():
    """POST /v1/records carries no caller identity, so it cannot reveal at all.

    A ``review.formal`` must come through ``POST /v1/reviews/reveal``, which is
    where the commitment is checked, the report gate is enforced and a signed
    review's public credit is decided.
    """
    reviewer, paper = Reviewer(), Paper()
    body = _signed_body(reviewer, paper)
    commit = reviewer.post_commit(paper, body)
    record = reviewer.reveal_record(paper, body)

    response = client.post(RECORDS_URL, json=record, headers=reviewer.headers)

    assert response.status_code == 422, response.text
    assert _problem_type(response) == REVIEW_RECORD_ROUTE
    row = get_review(commit["id"])
    assert row.revealed_at is None
    assert row.signed_by is None
    assert _profile_reviews(reviewer.did) == []

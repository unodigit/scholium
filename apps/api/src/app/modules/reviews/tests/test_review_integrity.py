"""Regression tests for review integrity (bug: review records bypassed the review rules).

Four defects are covered here, each exercised through the public API:

1. a ``review.commit`` posted to ``POST /v1/records`` skipped the tier-3,
   author, uniqueness and escrow checks that only ``POST /v1/reviews/commit``
   ran -- anyone, including a tier-0 caller or the paper's own author, could
   create a commit that counted toward the report gate and the paper status;
2. a first ``review.formal`` was accepted with only one commit on the version,
   so its report entered the append-only log and was served by
   ``GET /v1/records/{cid}`` and ``GET /v1/sync/range`` before the gate opened;
3. the uniqueness token was an HMAC keyed from ``JWT_SECRET`` instead of the
   dedicated ``REVIEW_UNIQUENESS_KEY``, so anyone holding the signing secret
   could recompute it for guessed DIDs and unmask reviewers;
4. ``POST /v1/reviews/commit`` appended the commit before sealing the escrow,
   so a missing committee key answered ``500`` and left an orphan commit.

The helpers of the feature-107 suite (a paper and a tier-3 reviewer with a
pseudonymous per-paper key) are reused; every test makes its own keys and paper,
so nothing is shared through the worker's database.
"""

from __future__ import annotations

import hashlib
import hmac
import json

import pytest
from fastapi.testclient import TestClient
from scholium_record_core import did_key_from_signing_key

from app.main import app
from app.modules import ledger
from app.modules.reviews import commitment_digest, get_review, uniqueness_token
from app.modules.reviews.errors import REVEAL_GATE_CLOSED
from app.modules.reviews.route_guard import REVIEW_RECORD_ROUTE
from app.modules.reviews.reveal import RUBRIC_DIMENSIONS
from app.security import issue_access_token
from app.settings import settings

from .test_review_commit import (
    COMMIT_TYPE,
    COMMIT_URL,
    Paper,
    Reviewer,
    _sign,
)

client = TestClient(app)
# The committee-key failure is an unhandled RuntimeError, which this client
# would otherwise re-raise instead of exposing the ``500`` the API answers.
raw_client = TestClient(app, raise_server_exceptions=False)

RECORDS_URL = "/v1/records"
REVEAL_URL = "/v1/reviews/reveal"
REVEAL_TYPE = "review.formal"


def _problem_type(response) -> str:
    return response.json()["type"]


def _rubric(reviewer: Reviewer, paper: Paper, *, report: str, target: str | None = None) -> dict:
    return {
        "target": target or paper.version_cid,
        "paper": paper.paper_cid,
        "scores": {
            dimension: {"score": 4, "justification": f"Why {dimension} is 4 of 5."}
            for dimension in RUBRIC_DIMENSIONS
        },
        "confidence": 4,
        "recommendation": "minor_revisions",
        "report": report,
        "reviewKey": did_key_from_signing_key(reviewer._review_key(paper)),
        "nullifier": reviewer.nullifier(paper),
    }


def _commit_record(reviewer: Reviewer, paper: Paper, body: dict) -> dict:
    """Seal ``body`` as this reviewer's ``review.commit`` (matching its digest)."""
    return _sign(
        reviewer._review_key(paper),
        COMMIT_TYPE,
        {
            "target": body["target"],
            "commitment": commitment_digest(body),
            "reviewKey": body["reviewKey"],
            "nullifier": reviewer.nullifier(paper),
        },
    )


def _reveal_record(reviewer: Reviewer, paper: Paper, body: dict) -> dict:
    revealed = dict(body)
    revealed["commitment"] = commitment_digest(body)
    return _sign(reviewer._review_key(paper), REVEAL_TYPE, revealed)


def _sync_entries(*, since: int, through: int) -> list[dict]:
    response = client.get(f"/v1/sync/range?from={since}&to={through}")
    assert response.status_code == 200, response.text
    return response.json()


def _head_seq() -> int:
    head = ledger.latest()
    return int(head.seq) if head is not None else 0


# --------------------------------------------------------------------------- #
# 1. review.commit on the generic route
# --------------------------------------------------------------------------- #


def test_a_tier_0_commit_on_the_generic_route_is_refused_and_not_logged():
    reviewer = Reviewer(tier=0)
    paper = Paper()
    record = reviewer.commit(paper)

    response = client.post(RECORDS_URL, json=record, headers=reviewer.headers)

    assert response.status_code == 422, response.text
    assert _problem_type(response) == REVIEW_RECORD_ROUTE
    assert ledger.entry_by_cid(record["id"]) is None
    assert get_review(record["id"]) is None


def test_the_papers_author_cannot_commit_through_the_generic_route():
    paper = Paper()
    # The paper's own signing key seals a commit -- exactly what the author
    # could do before the review rules were applied to every route in.
    body = {
        "target": paper.version_cid,
        "commitment": "ab" * 32,
        "reviewKey": paper.did,
        "nullifier": "cd" * 32,
    }
    record = _sign(paper.seed, COMMIT_TYPE, body)

    response = client.post(
        RECORDS_URL,
        json=record,
        headers={"Authorization": f"Bearer {issue_access_token(paper.did, 0)}"},
    )

    assert response.status_code == 422, response.text
    assert _problem_type(response) == REVIEW_RECORD_ROUTE
    assert ledger.entry_by_cid(record["id"]) is None
    assert get_review(record["id"]) is None


def test_a_commit_still_works_on_its_own_endpoint():
    reviewer, paper = Reviewer(), Paper()
    response = reviewer.post_commit(paper)
    assert response.status_code == 201, response.text


# --------------------------------------------------------------------------- #
# 2. the report gate on a first reveal
# --------------------------------------------------------------------------- #


def test_a_first_reveal_is_refused_until_two_independent_commits_exist():
    reviewer, paper = Reviewer(), Paper()
    body = _rubric(reviewer, paper, report="A report nobody should read yet.")
    commit = _commit_record(reviewer, paper, body)
    assert client.post(COMMIT_URL, json=commit, headers=reviewer.headers).status_code == 201
    reveal = _reveal_record(reviewer, paper, body)
    before = _head_seq()

    response = client.post(REVEAL_URL, json=reveal, headers=reviewer.headers)

    assert response.status_code == 409, response.text
    assert _problem_type(response) == REVEAL_GATE_CLOSED
    # Nothing reached the append-only log, so neither read route can serve it.
    assert ledger.entry_by_cid(reveal["id"]) is None
    assert client.get(f"{RECORDS_URL}/{reveal['id']}").status_code == 404
    body_text = json.dumps(_sync_entries(since=before - 1 if before else 0, through=_head_seq()))
    assert body["report"] not in body_text
    assert reveal["id"] not in body_text

    # A second, independent commit opens the gate; the same reveal is accepted.
    second = Reviewer()
    second_body = _rubric(second, paper, report="The second reviewer's sealed report.")
    second_commit = _commit_record(second, paper, second_body)
    assert client.post(COMMIT_URL, json=second_commit, headers=second.headers).status_code == 201
    response = client.post(REVEAL_URL, json=reveal, headers=reviewer.headers)

    assert response.status_code == 201, response.text
    stored = client.get(f"{RECORDS_URL}/{reveal['id']}")
    assert stored.status_code == 200, stored.text
    assert stored.json()["body"]["report"] == body["report"]
    after = _head_seq()
    served = json.dumps(_sync_entries(since=after - 1, through=after))
    assert reveal["id"] in served and body["report"] in served


def test_a_first_reveal_through_the_generic_route_is_refused_and_not_logged():
    reviewer, paper = Reviewer(), Paper()
    assert reviewer.post_commit(paper).status_code == 201
    body = _rubric(reviewer, paper, report="A report that must stay sealed.")
    reveal = _reveal_record(reviewer, paper, body)
    before = _head_seq()

    response = client.post(RECORDS_URL, json=reveal, headers=reviewer.headers)

    # REV-4 names the gate problem on both routes: the gate is shut, so the
    # generic route refuses the reveal for that reason.
    assert response.status_code == 409, response.text
    assert _problem_type(response) == REVEAL_GATE_CLOSED
    assert ledger.entry_by_cid(reveal["id"]) is None
    assert client.get(f"{RECORDS_URL}/{reveal['id']}").status_code == 404
    served = json.dumps(_sync_entries(since=before - 1 if before else 0, through=_head_seq()))
    assert body["report"] not in served
    assert reveal["id"] not in served


def test_a_generic_route_reveal_is_directed_to_the_endpoint_once_the_gate_is_open():
    reviewer, paper = Reviewer(), Paper()
    body = _rubric(reviewer, paper, report="A report that may be opened.")
    first = _commit_record(reviewer, paper, body)
    assert client.post(COMMIT_URL, json=first, headers=reviewer.headers).status_code == 201
    second = Reviewer()
    second_body = _rubric(second, paper, report="The second reviewer's sealed report.")
    second_commit = _commit_record(second, paper, second_body)
    assert client.post(COMMIT_URL, json=second_commit, headers=second.headers).status_code == 201
    reveal = _reveal_record(reviewer, paper, body)

    response = client.post(RECORDS_URL, json=reveal, headers=reviewer.headers)

    # With the gate open the only problem is that review records need the
    # endpoint that knows the caller.
    assert response.status_code == 422, response.text
    assert _problem_type(response) == REVIEW_RECORD_ROUTE
    assert ledger.entry_by_cid(reveal["id"]) is None


# --------------------------------------------------------------------------- #
# 3. the uniqueness token's key
# --------------------------------------------------------------------------- #


def test_the_uniqueness_token_is_keyed_by_review_uniqueness_key_not_jwt_secret(monkeypatch):
    did = "did:key:z6MkreviewerTokenTest"
    paper_cid = "bafyreitokenpaper"
    monkeypatch.setattr(settings, "JWT_SECRET", "jwt-secret-one")
    monkeypatch.setattr(settings, "REVIEW_UNIQUENESS_KEY", "review-key-one")

    first = uniqueness_token(did, paper_cid)

    # Rotating the signing secret never changes it.
    monkeypatch.setattr(settings, "JWT_SECRET", "jwt-secret-two")
    assert uniqueness_token(did, paper_cid) == first

    # Rotating the dedicated key does.
    monkeypatch.setattr(settings, "REVIEW_UNIQUENESS_KEY", "review-key-two")
    second = uniqueness_token(did, paper_cid)
    assert second != first

    # And it is exactly HMAC(REVIEW_UNIQUENESS_KEY, label || did || paper).
    message = b"\x00".join(
        (
            b"scholium:review-escrow:uniqueness:v1",
            did.encode("utf-8"),
            paper_cid.encode("utf-8"),
        )
    )
    expected = hmac.new(b"review-key-two", message, hashlib.sha256).hexdigest()
    assert second == expected


# --------------------------------------------------------------------------- #
# 4. escrow before the append
# --------------------------------------------------------------------------- #


def test_a_missing_committee_key_refuses_the_commit_without_an_orphan(monkeypatch):
    monkeypatch.setattr(settings, "SCHOLIUM_ENV", "production")
    monkeypatch.setattr(settings, "COMMITTEE_PUBLIC_KEY", "")
    reviewer, paper = Reviewer(), Paper()
    record = reviewer.commit(paper)

    response = raw_client.post(COMMIT_URL, json=record, headers=reviewer.headers)

    assert response.status_code == 500, response.text
    # The failed escrow happened first, so the log holds nothing to count.
    assert ledger.entry_by_cid(record["id"]) is None
    assert get_review(record["id"]) is None

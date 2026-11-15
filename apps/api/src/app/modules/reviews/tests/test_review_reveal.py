"""Tests for ``POST /v1/reviews/reveal`` (plugin: reviews, feature 109).

The paper is put in place the way ``test_review_commit`` does it: appended to
the event log and indexed through the submissions plugin's own ``save_paper`` /
``save_version``.  A reviewer is a fresh key with a tier-3 ``accounts`` row and
access token; the commit and the reveal are both signed by the reviewer's
pseudonymous per-paper key, never by their own DID.

The commitment is the one the module defines (:func:`commitment_digest`): the
SHA-256 of the canonical JSON of the review body, less its own ``commitment``.

A refusal is checked for its *reason* -- the problem type and the field error
-- not just its status, since several different problems share ``422``.

Isolation note: the test database is shared by every test in a worker, so each
test generates its own keys, DIDs and paper cid; nothing is shared.
"""

from __future__ import annotations

import copy
import hashlib
import json
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Optional

import pytest
from fastapi.testclient import TestClient
from nacl.signing import SigningKey
from scholium_record_core import (
    SCHEMA_DIR,
    compute_file_id,
    did_key_from_signing_key,
    sign_record,
)

from app import db
from app.main import app
from app.modules import ledger, reviews
from app.modules.identity.models import Account, ensure_account_table
from app.modules.reviews import (
    CONFIDENCE_LEVELS,
    RECOMMENDATIONS,
    RUBRIC_DIMENSIONS,
    apply_review_reveal,
    commitment_digest,
    get_review,
    normalise_recommendation,
)
from app.modules.reviews.errors import (
    REVIEW_ALREADY_REVEALED,
    REVIEW_COMMITMENT_MISMATCH,
    REVIEW_NOT_COMMITTED,
)
from app.modules.submissions import VersionAuthor, save_paper, save_version
from app.security import issue_access_token

client = TestClient(app)


@pytest.fixture(autouse=True)
def subscribed():
    """Put the package's ledger subscriptions back.

    The package subscribes when it is imported, but other suites call
    ``ledger.clear_subscribers()`` around their tests (ledger, search,
    moderation, appeals), which removes them for the rest of the worker's life.
    ``POST /v1/records`` relies on the subscription to fill in a revealed
    review, and a ``review.formal`` appended to the log is only left alone
    quietly if the subscriber is there to skip it; ``POST /v1/reviews/reveal``
    does not rely on it, because the endpoint applies the reveal itself.
    """
    reviews._install_ledger_subscriber()


COMMIT_URL = "/v1/reviews/commit"
REVEAL_URL = "/v1/reviews/reveal"
RECORDS_URL = "/v1/records"
COMMIT_TYPE = "review.commit"
REVEAL_TYPE = "review.formal"
CATEGORY = "cs.CR"


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _sha256_hex(*parts: bytes) -> str:
    return hashlib.sha256(b"|".join(parts)).hexdigest()


def _sign(seed: SigningKey, record_type: str, body: dict, prev: Optional[str] = None) -> dict:
    return sign_record(
        {
            "v": 1,
            "type": record_type,
            "author": did_key_from_signing_key(seed),
            "created": _timestamp(),
            "prev": prev,
            "body": body,
            "proofs": [],
        },
        seed,
    )


class Paper:
    """One listed paper with a single author."""

    def __init__(self) -> None:
        self.tag = uuid.uuid4().hex
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self.title = f"Review reveal test paper {self.tag}"
        self.abstract = "A paper whose review is committed and then revealed."

        manuscript = f"%PDF-1.7 test manuscript {self.tag}".encode()
        genesis = _sign(
            self.seed,
            "paper.genesis",
            {
                "seed": self.tag,
                "title": self.title,
                "abstract": self.abstract,
                "categories": [CATEGORY],
                "licence": "CC-BY-4.0",
                "authors": [self.did],
            },
        )
        manifest = _sign(
            self.seed,
            "manifest",
            {
                "files": [
                    {
                        "path": "main.pdf",
                        "cid": compute_file_id(manuscript),
                        "size": len(manuscript),
                        "mediaType": "application/pdf",
                        "role": "manuscript",
                    }
                ]
            },
        )
        version = _sign(
            self.seed,
            "paper.version",
            {
                "paper": genesis["id"],
                "n": 1,
                "title": self.title,
                "abstract": self.abstract,
                "authors": [{"did": self.did, "position": 1, "creditRoles": ["Conceptualization"]}],
                "manifest": manifest["id"],
                "licence": "CC-BY-4.0",
                "changeNote": "First version.",
            },
            prev=genesis["id"],
        )
        for record in (genesis, manifest, version):
            ledger.append(record)

        save_paper(paper_cid=genesis["id"], categories=(CATEGORY,))
        save_version(
            version_cid=version["id"],
            paper_cid=genesis["id"],
            n=1,
            title=self.title,
            abstract=self.abstract,
            manifest_cid=manifest["id"],
            licence="CC-BY-4.0",
            prev_cid=genesis["id"],
            change_note="First version.",
            authors=(VersionAuthor(self.did, 1, ("Conceptualization",)),),
            state="listed",
        )

        self.version_cid = version["id"]
        self.paper_cid = genesis["id"]


class Reviewer:
    """A member with one pseudonymous review key and nullifier per paper."""

    def __init__(self, tier: int = 3) -> None:
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self._secret = secrets.token_bytes(32)

        ensure_account_table()
        with db.SessionLocal() as session:
            session.add(Account(did=self.did, tier=tier, created_at=_now() - timedelta(days=400)))
            session.commit()

        self.headers = {"Authorization": f"Bearer {issue_access_token(self.did, tier)}"}

    def review_key(self, paper: Paper) -> SigningKey:
        return SigningKey(
            hashlib.sha256(
                b"review-key|" + self._secret + b"|" + paper.paper_cid.encode()
            ).digest()
        )

    def nullifier(self, paper: Paper) -> str:
        return _sha256_hex(self._secret, paper.paper_cid.encode())

    def rubric(self, paper: Paper, *, score: int = 4, report: Optional[str] = None) -> dict:
        """A complete review body: six scored, justified dimensions."""
        return {
            "target": paper.version_cid,
            "paper": paper.paper_cid,
            "scores": {
                dimension: {"score": score, "justification": f"Why {dimension} is {score} of 5."}
                for dimension in RUBRIC_DIMENSIONS
            },
            "confidence": 4,
            "recommendation": "minor_revisions",
            "report": report or f"A report on {paper.title}.",
            "reviewKey": did_key_from_signing_key(self.review_key(paper)),
            "nullifier": self.nullifier(paper),
        }

    def post_commit(self, paper: Paper, body: Mapping[str, Any]):
        """Seal ``body``; the setup fails if the node refuses the commit."""
        commit = _sign(
            self.review_key(paper),
            COMMIT_TYPE,
            {
                "target": paper.version_cid,
                "commitment": commitment_digest(body),
                "reviewKey": did_key_from_signing_key(self.review_key(paper)),
                "nullifier": self.nullifier(paper),
            },
        )
        response = client.post(COMMIT_URL, json=commit, headers=self.headers)
        assert response.status_code == 201, response.text
        return commit

    def reveal_record(
        self,
        paper: Paper,
        body: Mapping[str, Any],
        *,
        commitment: Optional[str] = None,
        signer: Optional[SigningKey] = None,
    ) -> dict:
        """A signed ``review.formal`` for ``body``.

        ``commitment`` defaults to the body's own digest -- an honest reveal --
        and ``signer`` to this reviewer's key for the paper.
        """
        revealed = dict(body)
        revealed["commitment"] = commitment if commitment is not None else commitment_digest(body)
        return _sign(signer or self.review_key(paper), REVEAL_TYPE, revealed)

    def post_reveal(self, paper: Paper, body: Mapping[str, Any], **kwargs: Any):
        return client.post(
            REVEAL_URL, json=self.reveal_record(paper, body, **kwargs), headers=self.headers
        )


def _sealed(body: Optional[Mapping[str, Any]] = None, *, score: int = 4):
    """A reviewer, a paper and a committed review: ready to be revealed."""
    reviewer, paper = Reviewer(), Paper()
    body = dict(body) if body is not None else reviewer.rubric(paper, score=score)
    commit = reviewer.post_commit(paper, body)
    return reviewer, paper, body, commit


def _problem_type(response) -> str:
    return response.json()["type"]


def _error_types(response) -> list[str]:
    return [error["type"] for error in response.json().get("errors", [])]


def _error_locs(response) -> list[list[Any]]:
    return [error["loc"] for error in response.json().get("errors", [])]


def _still_sealed(commit: Mapping[str, Any]) -> bool:
    row = get_review(commit["id"])
    return row is not None and row.revealed_at is None and row.scores is None


# --------------------------------------------------------------------------- #
# Accepted
# --------------------------------------------------------------------------- #


def test_a_reveal_with_all_six_scores_is_accepted_and_fills_in_the_review():
    reviewer, paper, body, commit = _sealed()
    record = reviewer.reveal_record(paper, body)

    response = client.post(REVEAL_URL, json=record, headers=reviewer.headers)

    assert response.status_code == 201, response.text
    answer = response.json()
    assert answer["id"] == record["id"]
    assert answer["review"] == commit["id"]
    assert answer["target"] == paper.version_cid
    assert answer["state"] == "revealed"

    row = get_review(commit["id"])
    assert row.scores == body["scores"]
    assert row.recommendation == "minor_revisions"
    assert row.confidence == 4
    assert row.revealed_at is not None
    # An inline report stays in the record; the row only names a report by reference.
    assert row.report_cid is None
    # Signing a review with a name is feature 111's, not the reveal's.
    assert row.signed_by is None
    # The sealed columns are untouched.
    assert row.review_key == commit["body"]["reviewKey"]
    assert row.committed_at is not None
    # The reveal is in the log, under its own cid.
    assert client.get(f"/v1/records/{record['id']}").status_code == 200


def test_a_report_carried_by_reference_is_saved_as_the_report_cid():
    reviewer, paper = Reviewer(), Paper()
    body = reviewer.rubric(paper)
    del body["report"]
    body["reportCid"] = "bafkreireportreference"
    commit = reviewer.post_commit(paper, body)

    response = reviewer.post_reveal(paper, body)

    assert response.status_code == 201, response.text
    assert get_review(commit["id"]).report_cid == "bafkreireportreference"


@pytest.mark.parametrize("level", sorted(CONFIDENCE_LEVELS))
def test_a_verbal_confidence_is_saved_as_an_integer(level):
    reviewer, paper = Reviewer(), Paper()
    body = reviewer.rubric(paper)
    body["confidence"] = level
    commit = reviewer.post_commit(paper, body)

    response = reviewer.post_reveal(paper, body)

    assert response.status_code == 201, response.text
    assert get_review(commit["id"]).confidence == CONFIDENCE_LEVELS[level]


def test_a_recommendation_is_saved_in_its_normalised_spelling():
    reviewer, paper = Reviewer(), Paper()
    body = reviewer.rubric(paper)
    body["recommendation"] = "Minor revisions"
    commit = reviewer.post_commit(paper, body)

    response = reviewer.post_reveal(paper, body)

    assert response.status_code == 201, response.text
    assert get_review(commit["id"]).recommendation == "minor_revisions"


def test_the_commitment_may_be_written_in_upper_case_hex():
    reviewer, paper, body, commit = _sealed()

    response = reviewer.post_reveal(paper, body, commitment=commitment_digest(body).upper())

    assert response.status_code == 201, response.text


# --------------------------------------------------------------------------- #
# The rubric
# --------------------------------------------------------------------------- #


def test_a_report_with_no_rubric_scores_is_refused():
    reviewer, paper = Reviewer(), Paper()
    body = reviewer.rubric(paper)
    del body["scores"]
    commit = reviewer.post_commit(paper, body)

    response = reviewer.post_reveal(paper, body)

    assert response.status_code == 422, response.text
    assert "missing_scores" in _error_types(response)
    assert ["body", "scores"] in _error_locs(response)
    assert "free-text report alone" in response.json()["detail"]
    assert _still_sealed(commit)


@pytest.mark.parametrize("dimension", RUBRIC_DIMENSIONS)
def test_a_review_missing_a_dimension_is_refused(dimension):
    reviewer, paper = Reviewer(), Paper()
    body = reviewer.rubric(paper)
    del body["scores"][dimension]
    commit = reviewer.post_commit(paper, body)

    response = reviewer.post_reveal(paper, body)

    assert response.status_code == 422, response.text
    assert _error_types(response) == ["missing_dimension"]
    assert _error_locs(response) == [["body", "scores", dimension]]
    assert _still_sealed(commit)


def test_a_bare_integer_for_a_dimension_is_refused():
    # The record schema takes one; the rubric needs the justification too.
    reviewer, paper = Reviewer(), Paper()
    body = reviewer.rubric(paper)
    body["scores"]["clarity"] = 5
    commit = reviewer.post_commit(paper, body)

    response = reviewer.post_reveal(paper, body)

    assert response.status_code == 422, response.text
    assert _error_types(response) == ["invalid_dimension"]
    assert _error_locs(response) == [["body", "scores", "clarity"]]
    assert _still_sealed(commit)


@pytest.mark.parametrize("score", [0, 6, -1, 3.5, "4", True, None])
def test_a_score_outside_1_to_5_is_refused(score):
    reviewer, paper = Reviewer(), Paper()
    body = reviewer.rubric(paper)
    body["scores"]["novelty"]["score"] = score
    commit = reviewer.post_commit(paper, body)

    response = reviewer.post_reveal(paper, body)

    assert response.status_code == 422, response.text
    assert "invalid_score" in _error_types(response)
    assert ["body", "scores", "novelty", "score"] in _error_locs(response)
    assert _still_sealed(commit)


@pytest.mark.parametrize("score", [1, 2, 3, 4, 5])
def test_every_score_from_1_to_5_is_accepted(score):
    reviewer, paper, body, _ = _sealed(score=score)

    assert reviewer.post_reveal(paper, body).status_code == 201


@pytest.mark.parametrize("justification", ["MISSING", "", "   \n\t", None, 4])
def test_a_score_without_a_justification_is_refused(justification):
    reviewer, paper = Reviewer(), Paper()
    body = reviewer.rubric(paper)
    if justification == "MISSING":
        del body["scores"]["evidence"]["justification"]
    else:
        body["scores"]["evidence"]["justification"] = justification
    commit = reviewer.post_commit(paper, body)

    response = reviewer.post_reveal(paper, body)

    assert response.status_code == 422, response.text
    assert _error_types(response) == ["missing_justification"]
    assert _error_locs(response) == [["body", "scores", "evidence", "justification"]]
    assert _still_sealed(commit)


def test_every_problem_with_the_rubric_is_reported_at_once():
    reviewer, paper = Reviewer(), Paper()
    body = reviewer.rubric(paper)
    del body["scores"]["soundness"]
    body["scores"]["clarity"]["score"] = 9
    del body["scores"]["limitations"]["justification"]
    del body["confidence"]
    body["recommendation"] = "perhaps"
    reviewer.post_commit(paper, body)

    response = reviewer.post_reveal(paper, body)

    assert response.status_code == 422, response.text
    assert sorted(_error_types(response)) == sorted(
        [
            "missing_dimension",
            "invalid_score",
            "missing_justification",
            "missing_confidence",
            "invalid_recommendation",
        ]
    )


@pytest.mark.parametrize("confidence", [0, 6, 2.5, True, "certain", ["high"]])
def test_an_invalid_confidence_is_refused(confidence):
    reviewer, paper = Reviewer(), Paper()
    body = reviewer.rubric(paper)
    body["confidence"] = confidence
    commit = reviewer.post_commit(paper, body)

    response = reviewer.post_reveal(paper, body)

    assert response.status_code == 422, response.text
    assert _error_types(response) == ["invalid_confidence"]
    assert _still_sealed(commit)


def test_a_missing_confidence_or_recommendation_is_refused():
    for field, kind in (("confidence", "missing_confidence"), ("recommendation", "missing_recommendation")):
        reviewer, paper = Reviewer(), Paper()
        body = reviewer.rubric(paper)
        del body[field]
        commit = reviewer.post_commit(paper, body)

        response = reviewer.post_reveal(paper, body)

        assert response.status_code == 422, response.text
        assert _error_types(response) == [kind]
        assert _still_sealed(commit)


def test_a_recommendation_the_schema_does_not_allow_is_refused():
    reviewer, paper = Reviewer(), Paper()
    body = reviewer.rubric(paper)
    body["recommendation"] = "publish immediately"
    commit = reviewer.post_commit(paper, body)

    response = reviewer.post_reveal(paper, body)

    assert response.status_code == 422, response.text
    assert _error_types(response) == ["invalid_recommendation"]
    assert _still_sealed(commit)


def test_the_recommendations_are_the_ones_the_schema_allows():
    schema = json.loads((SCHEMA_DIR / "review.formal.json").read_text())
    allowed = schema["properties"]["recommendation"]["enum"]

    assert {normalise_recommendation(value) for value in allowed} == set(RECOMMENDATIONS)


# --------------------------------------------------------------------------- #
# The commitment
# --------------------------------------------------------------------------- #


def test_the_commitment_is_the_sha256_of_the_canonical_body_less_its_commitment():
    body = {"b": 1, "a": ["é", {"d": 2, "c": None}], "commitment": "ignored"}

    expected = hashlib.sha256(
        '{"a":["é",{"c":null,"d":2}],"b":1}'.encode("utf-8")
    ).hexdigest()

    assert commitment_digest(body) == expected
    assert commitment_digest({k: v for k, v in body.items() if k != "commitment"}) == expected


def test_content_that_does_not_match_the_commitment_is_refused():
    reviewer, paper = Reviewer(), Paper()
    sealed = reviewer.rubric(paper, score=4, report="The sealed report.")
    commit = reviewer.post_commit(paper, sealed)
    different = reviewer.rubric(paper, score=2, report="A different report entirely.")

    response = reviewer.post_reveal(paper, different)

    assert response.status_code == 422, response.text
    assert _problem_type(response) == REVIEW_COMMITMENT_MISMATCH
    assert _error_types(response) == ["commitment_mismatch"]
    assert _still_sealed(commit)


def test_copying_the_sealed_commitment_onto_different_content_is_refused():
    # The commit's commitment, on content that does not hash to it: the field
    # matches the commit, the content does not match the field.
    reviewer, paper, sealed, commit = _sealed(score=4)
    changed = reviewer.rubric(paper, score=1, report="Written after seeing the others.")

    response = reviewer.post_reveal(paper, changed, commitment=commit["body"]["commitment"])

    assert response.status_code == 422, response.text
    assert _problem_type(response) == REVIEW_COMMITMENT_MISMATCH
    assert _error_types(response) == ["content_mismatch"]
    assert _still_sealed(commit)


def test_a_reveal_without_a_commitment_is_refused():
    reviewer, paper, body, commit = _sealed()
    record = reviewer.reveal_record(paper, body)
    del record["body"]["commitment"]
    record = sign_record({k: v for k, v in record.items() if k not in ("id", "sig")}, reviewer.review_key(paper))

    response = client.post(REVEAL_URL, json=record, headers=reviewer.headers)

    assert response.status_code == 422, response.text
    assert _error_types(response) == ["missing_commitment"]
    assert _still_sealed(commit)


def test_a_reveal_with_no_sealed_review_is_refused():
    reviewer, paper = Reviewer(), Paper()
    body = reviewer.rubric(paper)

    response = reviewer.post_reveal(paper, body)

    assert response.status_code == 422, response.text
    assert _problem_type(response) == REVIEW_NOT_COMMITTED


def test_another_review_key_cannot_open_a_sealed_review():
    reviewer, paper, body, commit = _sealed()
    intruder = Reviewer()

    # The intruder signs with their own key, copying everything else.
    response = intruder.post_reveal(
        paper,
        {**body, "reviewKey": did_key_from_signing_key(intruder.review_key(paper))},
        commitment=commit["body"]["commitment"],
        signer=intruder.review_key(paper),
    )

    assert response.status_code == 422, response.text
    assert _problem_type(response) == REVIEW_NOT_COMMITTED
    assert _still_sealed(commit)


def test_a_review_key_in_the_body_must_be_the_signers():
    reviewer, paper = Reviewer(), Paper()
    body = reviewer.rubric(paper)
    body["reviewKey"] = did_key_from_signing_key(SigningKey.generate())
    commit = reviewer.post_commit(paper, body)

    response = reviewer.post_reveal(paper, body)

    assert response.status_code == 422, response.text
    assert _error_types(response) == ["review_key_mismatch"]
    assert _still_sealed(commit)


# --------------------------------------------------------------------------- #
# Once, and who may
# --------------------------------------------------------------------------- #


def test_a_sealed_review_is_revealed_once():
    reviewer, paper, body, commit = _sealed()
    assert reviewer.post_reveal(paper, body).status_code == 201
    first = get_review(commit["id"])

    # The same review again, as a new record (another ``created`` is enough).
    again = reviewer.reveal_record(paper, body)
    again["created"] = (datetime.now(timezone.utc) + timedelta(seconds=5)).strftime("%Y-%m-%dT%H:%M:%SZ")
    again = sign_record({k: v for k, v in again.items() if k not in ("id", "sig")}, reviewer.review_key(paper))
    response = client.post(REVEAL_URL, json=again, headers=reviewer.headers)

    assert response.status_code == 409, response.text
    assert _problem_type(response) == REVIEW_ALREADY_REVEALED
    assert get_review(commit["id"]).revealed_at == first.revealed_at


def test_the_same_record_twice_is_a_duplicate():
    reviewer, paper, body, _ = _sealed()
    record = reviewer.reveal_record(paper, body)

    assert client.post(REVEAL_URL, json=record, headers=reviewer.headers).status_code == 201
    second = client.post(REVEAL_URL, json=record, headers=reviewer.headers)

    assert second.status_code == 409, second.text


def test_a_caller_below_tier_3_may_not_reveal():
    reviewer, paper, body, commit = _sealed()
    low = Reviewer(tier=2)

    response = client.post(
        REVEAL_URL, json=reviewer.reveal_record(paper, body), headers=low.headers
    )

    assert response.status_code == 403, response.text
    assert _still_sealed(commit)


def test_an_unauthenticated_caller_may_not_reveal():
    reviewer, paper, body, commit = _sealed()

    response = client.post(REVEAL_URL, json=reviewer.reveal_record(paper, body))

    assert response.status_code == 401, response.text
    assert _still_sealed(commit)


def test_a_tampered_signature_is_refused():
    reviewer, paper, body, commit = _sealed()
    record = reviewer.reveal_record(paper, body)
    record["body"] = copy.deepcopy(record["body"])
    record["body"]["report"] = "Edited after signing."

    response = client.post(REVEAL_URL, json=record, headers=reviewer.headers)

    assert response.status_code in (401, 422), response.text
    assert _still_sealed(commit)


def test_a_wrong_record_type_is_refused():
    reviewer, paper, body, commit = _sealed()
    record = reviewer.reveal_record(paper, body)
    record["type"] = "review.commit"

    response = client.post(REVEAL_URL, json=record, headers=reviewer.headers)

    assert response.status_code == 422, response.text
    assert _error_types(response) == ["wrong_record_type"]
    assert _still_sealed(commit)


def test_an_unknown_target_is_refused():
    reviewer, paper = Reviewer(), Paper()
    body = reviewer.rubric(paper)
    body["target"] = "bafyrei-not-a-version"

    response = reviewer.post_reveal(paper, body)

    assert response.status_code == 422, response.text
    assert _error_types(response) == ["unknown_review_target"]


# --------------------------------------------------------------------------- #
# Other routes into the log
# --------------------------------------------------------------------------- #


def test_a_reveal_through_the_generic_records_route_is_held_to_the_commitment():
    reviewer, paper, sealed, commit = _sealed(score=4)
    changed = reviewer.rubric(paper, score=1, report="Not what was sealed.")

    response = client.post(
        RECORDS_URL,
        json=reviewer.reveal_record(paper, changed, commitment=commit["body"]["commitment"]),
        headers=reviewer.headers,
    )

    assert response.status_code == 422, response.text
    assert _error_types(response) == ["content_mismatch"]
    assert _still_sealed(commit)


def test_a_reveal_through_the_generic_records_route_fills_in_the_review():
    reviewer, paper, body, commit = _sealed()

    response = client.post(
        RECORDS_URL, json=reviewer.reveal_record(paper, body), headers=reviewer.headers
    )

    assert response.status_code == 201, response.text
    row = get_review(commit["id"])
    assert row.revealed_at is not None
    assert row.scores == body["scores"]


def test_a_formal_review_appended_with_nothing_sealed_behind_it_is_left_alone():
    # Other plugins append ``review.formal`` straight to the log; with no
    # sealed review here there is nothing to open, and that is not an error.
    reviewer, paper = Reviewer(), Paper()
    record = reviewer.reveal_record(paper, reviewer.rubric(paper))

    entry = ledger.append(record)

    assert entry.record_cid == record["id"]
    assert get_review(record["id"]) is None


def test_applying_a_reveal_twice_gives_the_same_row():
    reviewer, paper, body, commit = _sealed()
    record = reviewer.reveal_record(paper, body)
    assert client.post(REVEAL_URL, json=record, headers=reviewer.headers).status_code == 201

    first = apply_review_reveal(record)
    second = apply_review_reveal(record)

    assert first.review_cid == second.review_cid == commit["id"]
    assert first.revealed_at == second.revealed_at

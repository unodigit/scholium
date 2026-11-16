"""Tests for updated reviews (plugin: reviews, feature 112).

A reviewer reviews a paper once, but may revise the review against a newer
version: a ``review.formal`` whose ``prev`` is their earlier ``review.formal``
and whose ``target`` is the newer version.  ``POST /v1/reviews/reveal`` accepts
it without a second commit, and ``GET /v1/papers/{id}/reviews`` serves both
reviews in the reviewer's ``history``.

The paper, the reviewers and the commit/reveal helpers are the ones
``test_review_reveal`` builds; this file adds a second (and third) version and
the signed update.  As there, every test makes its own keys, DIDs and paper, so
nothing is shared through the worker's database.
"""

from __future__ import annotations

import uuid
from typing import Any, Mapping, Optional

import pytest
from fastapi.testclient import TestClient
from nacl.signing import SigningKey
from scholium_record_core import (
    compute_file_id,
    derive_short_id,
    did_key_from_signing_key,
)

from app.main import app
from app.modules import ledger, reviews
from app.modules.reviews import RUBRIC_DIMENSIONS, commitment_digest, get_review
from app.modules.reviews.errors import (
    REVIEW_ALREADY_UPDATED,
    REVIEW_UPDATE_INVALID,
)
from app.modules.reviews.route_guard import REVIEW_RECORD_ROUTE
from app.modules.submissions import VersionAuthor, save_version

from .test_review_reveal import (
    COMMIT_TYPE,
    COMMIT_URL,
    REVEAL_TYPE,
    REVEAL_URL,
    RECORDS_URL,
    Paper,
    Reviewer,
    _error_types,
    _problem_type,
    _sealed,
    _sign,
    discard_reveal_gate_shadows,
    open_reveal_gate,
)

client = TestClient(app)


@pytest.fixture(autouse=True)
def subscribed():
    """Put the package's ledger subscriptions back (other suites clear them)."""
    reviews._install_ledger_subscriber()


def listing_url(paper: Paper, version: Optional[int] = None) -> str:
    """The reviews listing: the paper's latest listed version, or version ``version``."""
    if version is None:
        return f"/v1/papers/{derive_short_id(paper.paper_cid)}/reviews"
    return f"/v1/papers/{paper.version_cids[version - 1]}/reviews"


def publish_version(paper: Paper, n: int) -> str:
    """List version ``n`` of ``paper``, chained to the one before; return its cid."""
    if not hasattr(paper, "version_cids"):
        paper.version_cids = [paper.version_cid]
    previous = paper.version_cids[-1]
    assert len(paper.version_cids) == n - 1, "versions are published in order"

    manuscript = f"%PDF-1.7 test manuscript {paper.tag} v{n}".encode()
    manifest = _sign(
        paper.seed,
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
        paper.seed,
        "paper.version",
        {
            "paper": paper.paper_cid,
            "n": n,
            "title": paper.title,
            "abstract": paper.abstract,
            "authors": [{"did": paper.did, "position": 1, "creditRoles": ["Conceptualization"]}],
            "manifest": manifest["id"],
            "licence": "CC-BY-4.0",
            "changeNote": f"Version {n}.",
        },
        prev=previous,
    )
    for record in (manifest, version):
        ledger.append(record)
    save_version(
        version_cid=version["id"],
        paper_cid=paper.paper_cid,
        n=n,
        title=paper.title,
        abstract=paper.abstract,
        manifest_cid=manifest["id"],
        licence="CC-BY-4.0",
        prev_cid=previous,
        change_note=f"Version {n}.",
        authors=(VersionAuthor(paper.did, 1, ("Conceptualization",)),),
        state="listed",
    )
    paper.version_cids.append(version["id"])
    return version["id"]


def update_body(
    reviewer: Reviewer,
    paper: Paper,
    target: str,
    *,
    score: int = 2,
    recommendation: str = "major_concerns",
    report: Optional[str] = None,
    signer: Optional[SigningKey] = None,
) -> dict:
    """A complete review of ``target``, with no commitment: it is an update."""
    key = signer or reviewer.review_key(paper)
    return {
        "target": target,
        "paper": paper.paper_cid,
        "scores": {
            dimension: {"score": score, "justification": f"Revised: {dimension} is {score} of 5."}
            for dimension in RUBRIC_DIMENSIONS
        },
        "confidence": 5,
        "recommendation": recommendation,
        "report": report or f"An updated report on {paper.title}.",
        "reviewKey": did_key_from_signing_key(key),
    }


def update_record(
    reviewer: Reviewer,
    paper: Paper,
    target: str,
    prev: Optional[str],
    *,
    signer: Optional[SigningKey] = None,
    **body: Any,
) -> dict:
    """A signed ``review.formal`` updating review ``prev`` against ``target``."""
    key = signer or reviewer.review_key(paper)
    return _sign(
        key,
        REVEAL_TYPE,
        update_body(reviewer, paper, target, signer=key, **body),
        prev=prev,
    )


def post_update(reviewer: Reviewer, record: Mapping[str, Any]):
    return client.post(REVEAL_URL, json=record, headers=reviewer.headers)


def revealed_review(reviewer: Reviewer, paper: Paper):
    """Commit and reveal a first review of ``paper`` v1; return ``(commit, formal)``."""
    body = reviewer.rubric(paper, score=4)
    commit = reviewer.post_commit(paper, body)
    formal = reviewer.reveal_record(paper, body)
    response = client.post(REVEAL_URL, json=formal, headers=reviewer.headers)
    assert response.status_code == 201, response.text
    # The setup's gate-opening commit is not part of what these tests list.
    discard_reveal_gate_shadows(paper.version_cid)
    return commit, formal


def commit_on(reviewer: Reviewer, paper: Paper, target: str, body: Mapping[str, Any]) -> dict:
    """Seal ``body`` against version ``target`` (the helper on ``Reviewer`` seals v1)."""
    commit = _sign(
        reviewer.review_key(paper),
        COMMIT_TYPE,
        {
            "target": target,
            "commitment": commitment_digest(body),
            "reviewKey": did_key_from_signing_key(reviewer.review_key(paper)),
            "nullifier": reviewer.nullifier(paper),
        },
    )
    response = client.post(COMMIT_URL, json=commit, headers=reviewer.headers)
    assert response.status_code == 201, response.text
    # A test that reveals this commit needs the version's gate open.
    open_reveal_gate(paper, target)
    return commit


def listed_reviews(paper: Paper, version: Optional[int] = None) -> list[dict]:
    response = client.get(listing_url(paper, version))
    assert response.status_code == 200, response.text
    return response.json()["reviews"]


def history_of(item: Mapping[str, Any]) -> list[str]:
    return [entry["formal_cid"] for entry in item["history"]]


def _reviewer_and_paper_on_two_versions():
    """A reviewer with a revealed v1 review of a paper that now has a v2."""
    reviewer, paper = Reviewer(), Paper()
    commit, first = revealed_review(reviewer, paper)
    v2 = publish_version(paper, 2)
    return reviewer, paper, commit, first, v2


# --------------------------------------------------------------------------- #
# Accepted
# --------------------------------------------------------------------------- #


def test_an_updated_review_against_a_newer_version_is_accepted():
    reviewer, paper, commit, first, v2 = _reviewer_and_paper_on_two_versions()
    update = update_record(reviewer, paper, v2, first["id"])

    response = post_update(reviewer, update)

    assert response.status_code == 201, response.text
    answer = response.json()
    assert answer["id"] == update["id"]
    assert answer["target"] == v2
    # It is the same review, not a second one: the commit it stands behind.
    assert answer["review"] == commit["id"]
    assert answer["prev"] == first["id"]
    assert answer["state"] == "revealed"
    # The update is a record in the log under its own cid.
    assert client.get(f"/v1/records/{update['id']}").status_code == 200


def test_an_update_does_not_rewrite_the_review_row():
    reviewer, paper, commit, first, v2 = _reviewer_and_paper_on_two_versions()
    before = get_review(commit["id"])

    assert post_update(reviewer, update_record(reviewer, paper, v2, first["id"])).status_code == 201

    after = get_review(commit["id"])
    # The row is what the commit and the first reveal left: v1, and v1's scores.
    assert after.version_cid == paper.version_cid
    assert after.scores == before.scores
    assert after.recommendation == before.recommendation == "minor_revisions"
    assert after.revealed_at == before.revealed_at


def test_an_update_needs_no_commitment_and_checks_none_it_carries():
    reviewer, paper, commit, first, v2 = _reviewer_and_paper_on_two_versions()
    body = update_body(reviewer, paper, v2)
    body["commitment"] = "not-the-commitment-of-anything"
    update = _sign(reviewer.review_key(paper), REVEAL_TYPE, body, prev=first["id"])

    assert post_update(reviewer, update).status_code == 201


def test_an_update_is_refused_through_the_generic_record_endpoint():
    """An update is a ``review.formal``; review types belong on the review routes."""
    reviewer, paper, commit, first, v2 = _reviewer_and_paper_on_two_versions()
    update = update_record(reviewer, paper, v2, first["id"])

    response = client.post(RECORDS_URL, json=update, headers=reviewer.headers)

    assert response.status_code == 422, response.text
    assert _problem_type(response) == REVIEW_RECORD_ROUTE
    [item] = listed_reviews(paper, version=1)
    assert history_of(item) == [first["id"]]


def test_an_update_may_update_an_update():
    reviewer, paper, commit, first, v2 = _reviewer_and_paper_on_two_versions()
    second = update_record(reviewer, paper, v2, first["id"], score=3)
    assert post_update(reviewer, second).status_code == 201
    v3 = publish_version(paper, 3)
    third = update_record(reviewer, paper, v3, second["id"], score=5, recommendation="accept")

    response = post_update(reviewer, third)

    assert response.status_code == 201, response.text
    assert response.json()["review"] == commit["id"]
    [item] = listed_reviews(paper)
    assert history_of(item) == [first["id"], second["id"], third["id"]]
    assert [entry["version"] for entry in item["history"]] == [1, 2, 3]


def test_an_update_may_skip_a_version():
    reviewer, paper, commit, first, v2 = _reviewer_and_paper_on_two_versions()
    v3 = publish_version(paper, 3)

    assert post_update(reviewer, update_record(reviewer, paper, v3, first["id"])).status_code == 201


def test_a_reveal_may_link_back_to_its_own_commit_through_prev():
    reviewer, paper = Reviewer(), Paper()
    body = reviewer.rubric(paper)
    commit = reviewer.post_commit(paper, body)
    revealed = dict(body, commitment=commitment_digest(body))
    record = _sign(reviewer.review_key(paper), REVEAL_TYPE, revealed, prev=commit["id"])

    response = post_update(reviewer, record)

    assert response.status_code == 201, response.text
    assert response.json()["review"] == commit["id"]
    assert get_review(commit["id"]).revealed_at is not None


# --------------------------------------------------------------------------- #
# The history GET /v1/papers/{id}/reviews serves
# --------------------------------------------------------------------------- #


def test_the_listing_returns_both_reviews_in_the_reviewers_history():
    reviewer, paper, commit, first, v2 = _reviewer_and_paper_on_two_versions()
    update = update_record(reviewer, paper, v2, first["id"], score=2, recommendation="major_concerns")
    assert post_update(reviewer, update).status_code == 201

    response = client.get(listing_url(paper))

    assert response.status_code == 200, response.text
    listing = response.json()
    assert listing["version_cid"] == v2
    # One reviewer, one entry -- not two.
    [item] = listing["reviews"]
    assert item["review_cid"] == commit["id"]
    assert item["label"] == "Reviewer A"
    assert history_of(item) == [first["id"], update["id"]]
    # Both are in the history, oldest version first, each as of its own version.
    earlier, latest = item["history"]
    assert earlier["version_cid"] == paper.version_cid and earlier["version"] == 1
    assert earlier["prev"] is None
    assert earlier["recommendation"] == "minor_revisions"
    assert {s["score"] for s in earlier["scores"].values()} == {4}
    assert latest["version_cid"] == v2 and latest["version"] == 2
    assert latest["prev"] == first["id"]
    assert latest["recommendation"] == "major_concerns"
    assert {s["score"] for s in latest["scores"].values()} == {2}
    assert latest["confidence"] == 5
    assert latest["revealed_at"] is not None


def test_the_review_itself_is_the_latest_one():
    reviewer, paper, commit, first, v2 = _reviewer_and_paper_on_two_versions()
    update = update_record(reviewer, paper, v2, first["id"], score=2, recommendation="major_concerns")
    assert post_update(reviewer, update).status_code == 201

    [item] = listed_reviews(paper)

    assert item["id"] == item["formal_cid"] == item["reveal_cid"] == update["id"]
    assert item["recommendation"] == "major_concerns"
    assert item["confidence"] == 5
    assert {s["score"] for s in item["scores"].values()} == {2}
    assert item["version_cid"] == v2 and item["version"] == 2
    assert item["revealed_at"] == item["history"][-1]["revealed_at"]
    # The commit's own date is not moved by revising the review.
    assert item["committed_at"] == get_review(commit["id"]).committed_at.isoformat()


def test_a_review_that_was_not_updated_has_a_history_of_one():
    reviewer, paper, commit, first, _ = _reviewer_and_paper_on_two_versions()

    # v1 is no longer the latest, so ask for it by its own cid.
    [item] = listed_reviews(paper, version=1)

    assert history_of(item) == [first["id"]]
    assert item["id"] == first["id"]
    assert item["history"][0]["prev"] is None


def test_an_older_versions_listing_shows_the_reviews_as_they_stood_then():
    reviewer, paper, commit, first, v2 = _reviewer_and_paper_on_two_versions()
    update = update_record(reviewer, paper, v2, first["id"])
    assert post_update(reviewer, update).status_code == 201

    [then] = listed_reviews(paper, version=1)
    [now] = listed_reviews(paper, version=2)

    assert history_of(then) == [first["id"]]
    assert then["recommendation"] == "minor_revisions"
    assert update["id"] not in client.get(listing_url(paper, 1)).text
    assert history_of(now) == [first["id"], update["id"]]


def test_a_reviewer_who_updated_is_listed_beside_one_who_reviewed_the_new_version():
    paper, updater, newcomer = Paper(), Reviewer(), Reviewer()
    commit, first = revealed_review(updater, paper)
    v2 = publish_version(paper, 2)
    update = update_record(updater, paper, v2, first["id"])
    assert post_update(updater, update).status_code == 201
    # A second reviewer commits and reveals on v2 itself.
    body = newcomer.rubric(paper)
    body["target"] = v2
    newcomer_commit = commit_on(newcomer, paper, v2, body)
    newcomer_formal = newcomer.reveal_record(paper, body)
    assert post_update(newcomer, newcomer_formal).status_code == 201
    discard_reveal_gate_shadows(v2)

    items = {item["review_cid"]: item for item in listed_reviews(paper)}

    assert set(items) == {commit["id"], newcomer_commit["id"]}
    # Labels follow commit order; the records are dated to the second, so two
    # commits made together may take either order.
    assert {item["label"] for item in items.values()} == {"Reviewer A", "Reviewer B"}
    assert history_of(items[commit["id"]]) == [first["id"], update["id"]]
    assert history_of(items[newcomer_commit["id"]]) == [newcomer_formal["id"]]
    assert items[newcomer_commit["id"]]["version_cid"] == v2


def test_the_report_gate_applies_to_every_review_in_the_history():
    reviewer, paper, commit, first, v2 = _reviewer_and_paper_on_two_versions()
    update = update_record(reviewer, paper, v2, first["id"], report="Revised report text.")
    assert post_update(reviewer, update).status_code == 201

    listing = client.get(listing_url(paper)).json()

    # One review is committed on a fresh paper: the gate is shut, so no report.
    assert listing["gate_open"] is False
    [item] = listing["reviews"]
    assert "report" not in item
    assert all("report" not in entry for entry in item["history"])
    assert "Revised report text." not in client.get(listing_url(paper)).text


def test_the_reports_in_the_history_are_served_once_the_gate_opens():
    paper, first_reviewer, second_reviewer = Paper(), Reviewer(), Reviewer()
    commit, first = revealed_review(first_reviewer, paper)
    v2 = publish_version(paper, 2)
    update = update_record(first_reviewer, paper, v2, first["id"], report="Revised report text.")
    assert post_update(first_reviewer, update).status_code == 201
    # A second review committed on v2 opens the gate for that version's listing.
    second_body = second_reviewer.rubric(paper)
    second_body["target"] = v2
    commit_on(second_reviewer, paper, v2, second_body)

    listing = client.get(listing_url(paper)).json()

    assert listing["gate_open"] is True
    item = next(entry for entry in listing["reviews"] if entry["review_cid"] == commit["id"])
    assert item["report"] == "Revised report text."
    assert [entry["report"] for entry in item["history"]] == [
        first["body"]["report"],
        "Revised report text.",
    ]


def test_an_author_can_answer_an_updated_review_by_its_cid():
    reviewer, paper, commit, first, v2 = _reviewer_and_paper_on_two_versions()
    update = update_record(reviewer, paper, v2, first["id"])
    assert post_update(reviewer, update).status_code == 201

    from datetime import datetime, timedelta, timezone

    from app import db
    from app.modules.identity.models import Account, ensure_account_table
    from app.security import issue_access_token

    ensure_account_table()
    with db.SessionLocal() as session:
        session.add(
            Account(
                did=paper.did,
                tier=3,
                created_at=datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=400),
            )
        )
        session.commit()
    marker = f"Author reply {uuid.uuid4().hex}"
    reply = _sign(
        paper.seed,
        "review.response",
        {
            "review": update["id"],
            "items": [
                {"dimension": dimension, "reply": f"{marker} {dimension}"}
                for dimension in RUBRIC_DIMENSIONS
            ],
        },
    )

    response = client.post(
        f"/v1/reviews/{update['id']}/response",
        json=reply,
        headers={"Authorization": f"Bearer {issue_access_token(paper.did, 3)}"},
    )

    # The updated review's cid names the same review the commit does.
    assert response.status_code == 201, response.text
    assert response.json()["review_cid"] == commit["id"]
    [item] = listed_reviews(paper)
    assert item["responses"][0]["replies"]["soundness"] == f"{marker} soundness"


# --------------------------------------------------------------------------- #
# Refused
# --------------------------------------------------------------------------- #


def _update_is_refused(response, kind: str) -> None:
    assert response.status_code == 422, response.text
    assert _problem_type(response) == REVIEW_UPDATE_INVALID
    assert _error_types(response) == [kind]


def test_an_update_may_not_replace_another_reviewers_review():
    paper, owner, intruder = Paper(), Reviewer(), Reviewer()
    owner_commit, owners = revealed_review(owner, paper)
    intruder_commit, _ = revealed_review(intruder, paper)
    v2 = publish_version(paper, 2)
    forged = update_record(intruder, paper, v2, owners["id"])

    response = post_update(intruder, forged)

    _update_is_refused(response, "prev_not_by_reviewer")
    assert response.json()["errors"][0]["loc"] == ["prev"]
    # Nothing was logged, and the owner's history stands.
    assert client.get(f"/v1/records/{forged['id']}").status_code == 404
    items = {item["review_cid"]: item for item in listed_reviews(paper, version=1)}
    assert history_of(items[owner_commit["id"]]) == [owners["id"]]


def test_an_update_whose_prev_this_node_does_not_hold_is_refused():
    reviewer, paper, commit, first, v2 = _reviewer_and_paper_on_two_versions()
    update = update_record(reviewer, paper, v2, "bafyreiaunknownreviewcid")

    _update_is_refused(post_update(reviewer, update), "unknown_prev")


def test_an_update_whose_prev_is_not_a_review_is_refused():
    reviewer, paper, commit, first, v2 = _reviewer_and_paper_on_two_versions()
    update = update_record(reviewer, paper, v2, paper.paper_cid)

    _update_is_refused(post_update(reviewer, update), "unknown_prev")


def test_an_update_against_the_same_version_is_refused():
    reviewer, paper, commit, first, v2 = _reviewer_and_paper_on_two_versions()
    update = update_record(reviewer, paper, paper.version_cid, first["id"])

    response = post_update(reviewer, update)

    _update_is_refused(response, "not_a_newer_version")
    assert response.json()["errors"][0]["loc"] == ["body", "target"]


def test_an_update_against_an_older_version_is_refused():
    reviewer, paper, commit, first, v2 = _reviewer_and_paper_on_two_versions()
    second = update_record(reviewer, paper, v2, first["id"])
    assert post_update(reviewer, second).status_code == 201
    backwards = update_record(reviewer, paper, paper.version_cid, second["id"])

    _update_is_refused(post_update(reviewer, backwards), "not_a_newer_version")


def test_an_update_may_not_move_a_review_to_another_paper():
    reviewer, paper, commit, first, v2 = _reviewer_and_paper_on_two_versions()
    other = Paper()
    # Signed by the key that wrote the first review, but aimed at another paper.
    stray = update_record(reviewer, paper, other.version_cid, first["id"])

    _update_is_refused(post_update(reviewer, stray), "prev_other_paper")


def test_an_update_must_have_a_complete_rubric():
    reviewer, paper, commit, first, v2 = _reviewer_and_paper_on_two_versions()
    body = update_body(reviewer, paper, v2)
    del body["scores"]["clarity"]
    update = _sign(reviewer.review_key(paper), REVEAL_TYPE, body, prev=first["id"])

    response = post_update(reviewer, update)

    assert response.status_code == 422, response.text
    assert _error_types(response) == ["missing_dimension"]
    [item] = listed_reviews(paper, version=1)
    assert history_of(item) == [first["id"]]


def test_an_update_must_name_a_target_this_node_holds():
    reviewer, paper, commit, first, v2 = _reviewer_and_paper_on_two_versions()
    update = update_record(reviewer, paper, "bafyreiaunknownversion", first["id"])

    response = post_update(reviewer, update)

    assert response.status_code == 422, response.text
    assert "unknown_review_target" in _error_types(response)


def test_a_review_is_replaced_once():
    reviewer, paper, commit, first, v2 = _reviewer_and_paper_on_two_versions()
    winner = update_record(reviewer, paper, v2, first["id"], score=3)
    assert post_update(reviewer, winner).status_code == 201
    v3 = publish_version(paper, 3)
    fork = update_record(reviewer, paper, v3, first["id"], score=1)

    response = post_update(reviewer, fork)

    assert response.status_code == 409, response.text
    assert _problem_type(response) == REVIEW_ALREADY_UPDATED
    assert response.json()["update"] == winner["id"]
    assert response.json()["review"] == first["id"]
    assert client.get(f"/v1/records/{fork['id']}").status_code == 404
    [item] = listed_reviews(paper, version=2)
    assert history_of(item) == [first["id"], winner["id"]]


def test_an_unauthenticated_update_is_refused():
    reviewer, paper, commit, first, v2 = _reviewer_and_paper_on_two_versions()
    update = update_record(reviewer, paper, v2, first["id"])

    response = client.post(REVEAL_URL, json=update)

    assert response.status_code == 401, response.text


def test_a_first_reveal_with_a_dangling_prev_is_refused_rather_than_ignored():
    reviewer, paper, body, commit = _sealed()
    revealed = dict(body, commitment=commitment_digest(body))
    record = _sign(reviewer.review_key(paper), REVEAL_TYPE, revealed, prev="bafyreiadangling")

    _update_is_refused(post_update(reviewer, record), "unknown_prev")
    assert get_review(commit["id"]).revealed_at is None

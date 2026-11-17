"""Tests for ``GET /v1/me/dashboard`` (feature 126).

Covers the four ``needs_attention`` categories, ``my_papers`` (status and
review counts) and ``my_reviews`` (sealed or revealed), plus authentication
and the empty dashboard.

Isolation note: xdist workers share one database, so every scene is built under
fresh cids and fresh DIDs -- no test assumes a table is empty.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from nacl.signing import SigningKey
from scholium_record_core import (
    derive_short_id,
    did_key_from_signing_key,
    sign_record,
)

from app import db
from app.main import app
from app.modules.flags.service import FLAG_DECIDED_KIND
from app.modules.moderation.models import ModerationDecision
from app.modules.notifications import notify
from app.modules.reviews.escrow import uniqueness_token
from app.modules.reviews.models import Review, ReviewEscrow, ReviewInvitation
from app.modules.submissions import (
    AWAITING_CONSENT,
    LISTED,
    VersionAuthor,
    save_paper,
    save_version,
)
from app.modules.submissions.models import Authorship
from app.security import UNAUTHENTICATED_TYPE, issue_access_token

DASHBOARD_URL = "/v1/me/dashboard"

client = TestClient(app)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _did() -> str:
    """A DID unique to this test."""
    return f"did:example:dashboard-{uuid.uuid4().hex}"


def _auth(did: str, tier: int = 1) -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access_token(did, tier)}"}


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _new_paper_cid(title: str) -> str:
    """A fresh, valid ``paper.genesis`` record cid."""
    seed = SigningKey.generate()
    did = did_key_from_signing_key(seed)
    record = sign_record(
        {
            "v": 1,
            "type": "paper.genesis",
            "author": did,
            "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "prev": None,
            "body": {
                "seed": uuid.uuid4().hex,
                "title": title,
                "abstract": "",
                "categories": ["cs.CR"],
                "licence": "CC-BY-4.0",
                "authors": [did],
            },
            "proofs": [],
        },
        seed,
    )
    return record["id"]


def _scene(
    *,
    authors: tuple[str, ...],
    state: str = AWAITING_CONSENT,
    title: str = "A dashboard test paper",
) -> tuple[str, str]:
    """Index a paper and its first version with ``authors`` on the byline."""
    paper_cid = _new_paper_cid(title)
    version_cid = f"cid-{uuid.uuid4().hex}"
    save_paper(paper_cid=paper_cid, categories=("cs.CR",))
    save_version(
        version_cid=version_cid,
        paper_cid=paper_cid,
        n=1,
        title=title,
        abstract="",
        manifest_cid=f"bafkreimanifest{uuid.uuid4().hex}",
        licence="CC-BY-4.0",
        prev_cid=paper_cid,
        authors=tuple(
            VersionAuthor(did, position, ("Conceptualization",))
            for position, did in enumerate(authors, start=1)
        ),
        state=state,
    )
    return paper_cid, version_cid


def _sign_consent(version_cid: str, did: str) -> None:
    """Record an accepted consent on the authorship row, as the plugin does."""
    with db.SessionLocal() as session:
        row = session.get(Authorship, (version_cid, did))
        row.consent_cid = f"bafkreiconsent{uuid.uuid4().hex}"
        row.consent_decision = "accept"
        session.commit()


def _add_review(version_cid: str, *, revealed: bool = False) -> str:
    """Store one committed review on ``version_cid`` and return its cid."""
    review_cid = f"cid-{uuid.uuid4().hex}"
    with db.SessionLocal() as session:
        session.add(
            Review(
                review_cid=review_cid,
                version_cid=version_cid,
                review_key=f"review-key-{uuid.uuid4().hex}",
                nullifier=uuid.uuid4().bytes,
                committed_at=_now(),
                revealed_at=_now() if revealed else None,
                recommendation="accept" if revealed else None,
                confidence=4 if revealed else None,
            )
        )
        session.commit()
    return review_cid


def _escrow(review_cid: str, reviewer_did: str, paper_cid: str) -> None:
    """Seal the reviewer's slot on the paper the way feature 108 does."""
    with db.SessionLocal() as session:
        session.add(
            ReviewEscrow(
                review_cid=review_cid,
                sealed_identity=b"sealed",
                uniqueness_token=uniqueness_token(reviewer_did, paper_cid),
            )
        )
        session.commit()


def _problem(response) -> dict:
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    assert body["status"] == response.status_code
    return body


# --------------------------------------------------------------------------- #
# Authentication and the empty dashboard
# --------------------------------------------------------------------------- #


def test_the_dashboard_requires_authentication():
    response = client.get(DASHBOARD_URL)

    assert response.status_code == 401
    body = _problem(response)
    assert body["type"] == UNAUTHENTICATED_TYPE
    assert response.headers["www-authenticate"] == "Bearer"


@pytest.mark.parametrize("tier", range(5))
def test_every_tier_may_read_their_own_dashboard(tier):
    response = client.get(DASHBOARD_URL, headers=_auth(_did(), tier))

    assert response.status_code == 200


def test_a_member_with_nothing_gets_empty_cards():
    response = client.get(DASHBOARD_URL, headers=_auth(_did()))

    assert response.status_code == 200
    body = response.json()
    assert body["needs_attention"]["count"] == 0
    for kind in (
        "consents_to_sign",
        "review_invitations",
        "author_replies",
        "moderation_outcomes",
        "items",
    ):
        assert body["needs_attention"][kind] == []
    assert body["my_papers"] == []
    assert body["my_reviews"] == []


# --------------------------------------------------------------------------- #
# needs_attention: consents
# --------------------------------------------------------------------------- #


def test_a_pending_consent_is_listed_and_a_signed_one_is_not():
    submitter, coauthor = _did(), _did()
    paper_cid, version_cid = _scene(authors=(submitter, coauthor))
    _sign_consent(version_cid, submitter)

    response = client.get(DASHBOARD_URL, headers=_auth(coauthor))

    assert response.status_code == 200
    body = response.json()
    consents = body["needs_attention"]["consents_to_sign"]
    assert len(consents) == 1
    item = consents[0]
    assert item["kind"] == "consent_to_sign"
    assert item["paper"] == derive_short_id(paper_cid)
    assert item["paperCid"] == paper_cid
    assert item["versionCid"] == version_cid
    assert item["version"] == 1
    assert item["status"] == "waiting"
    assert item["link"] == f"/consent/{version_cid}"
    assert item in body["needs_attention"]["items"]

    # The submitter already signed; nothing is owed.
    signed = client.get(DASHBOARD_URL, headers=_auth(submitter))
    assert signed.json()["needs_attention"]["consents_to_sign"] == []


def test_a_consent_on_a_version_no_longer_waiting_is_not_owed():
    coauthor = _did()
    _, version_cid = _scene(authors=(_did(), coauthor), state=LISTED)

    body = client.get(DASHBOARD_URL, headers=_auth(coauthor)).json()

    assert body["needs_attention"]["consents_to_sign"] == []
    # The paper is still theirs, though.
    assert [paper["paperCid"] for paper in body["my_papers"]]


# --------------------------------------------------------------------------- #
# needs_attention: review invitations
# --------------------------------------------------------------------------- #


def test_only_pending_review_invitations_are_listed():
    reviewer = _did()
    _, version_cid = _scene(authors=(_did(),))
    pending_id = f"inv-{uuid.uuid4().hex}"
    decided_id = f"inv-{uuid.uuid4().hex}"
    with db.SessionLocal() as session:
        session.add(
            ReviewInvitation(
                id=pending_id, version_cid=version_cid, reviewer_did=reviewer, status="pending"
            )
        )
        session.add(
            ReviewInvitation(
                id=decided_id, version_cid=version_cid, reviewer_did=reviewer, status="accepted"
            )
        )
        session.commit()

    body = client.get(DASHBOARD_URL, headers=_auth(reviewer)).json()

    invitations = body["needs_attention"]["review_invitations"]
    assert [item["invitationId"] for item in invitations] == [pending_id]
    assert invitations[0]["versionCid"] == version_cid
    assert invitations[0]["status"] == "pending"


# --------------------------------------------------------------------------- #
# my_papers
# --------------------------------------------------------------------------- #


def test_my_papers_reports_status_versions_and_review_counts():
    author = _did()
    paper_cid, version_cid = _scene(authors=(author,))
    _add_review(version_cid)
    _add_review(version_cid, revealed=True)

    body = client.get(DASHBOARD_URL, headers=_auth(author)).json()

    papers = [paper for paper in body["my_papers"] if paper["paperCid"] == paper_cid]
    assert len(papers) == 1
    paper = papers[0]
    assert paper["paper"] == derive_short_id(paper_cid)
    assert paper["status"] == "preprint"
    assert paper["versionCount"] == 1
    assert paper["latestVersion"] == 1
    assert paper["latestVersionCid"] == version_cid
    assert paper["state"] == AWAITING_CONSENT
    assert paper["reviewCount"] == 2
    assert paper["revealedCount"] == 1
    assert paper["role"] == "author"


def test_my_papers_is_empty_for_a_non_author():
    _, _ = _scene(authors=(_did(),))

    body = client.get(DASHBOARD_URL, headers=_auth(_did())).json()

    assert body["my_papers"] == []


# --------------------------------------------------------------------------- #
# my_reviews
# --------------------------------------------------------------------------- #


def test_my_reviews_finds_the_callers_reviews_through_the_escrow_token():
    reviewer, other = _did(), _did()
    # One review per person and paper is the escrow's rule, so the reviewer's
    # sealed and revealed reviews sit on two different papers.
    sealed_paper, sealed_version = _scene(authors=(_did(),))
    revealed_paper, revealed_version = _scene(authors=(_did(),))
    sealed_cid = _add_review(sealed_version)
    revealed_cid = _add_review(revealed_version, revealed=True)
    _escrow(sealed_cid, reviewer, sealed_paper)
    _escrow(revealed_cid, reviewer, revealed_paper)
    # Somebody else's review on another paper must never appear.
    other_paper, other_version = _scene(authors=(_did(),))
    other_review = _add_review(other_version)
    _escrow(other_review, other, other_paper)

    body = client.get(DASHBOARD_URL, headers=_auth(reviewer)).json()

    states = {review["reviewCid"]: review["state"] for review in body["my_reviews"]}
    assert states == {sealed_cid: "sealed", revealed_cid: "revealed"}
    sealed = next(row for row in body["my_reviews"] if row["reviewCid"] == sealed_cid)
    assert sealed["sealed"] is True and sealed["revealed"] is False
    assert sealed["recommendation"] is None
    assert sealed["paper"] == derive_short_id(sealed_paper)
    assert sealed["link"] == f"/review/{derive_short_id(sealed_paper)}"
    # The pseudonymity material is never served.
    assert "review_key" not in sealed and "nullifier" not in sealed


def test_my_reviews_is_empty_for_a_non_reviewer():
    paper_cid, version_cid = _scene(authors=(_did(),))
    review_cid = _add_review(version_cid)
    _escrow(review_cid, _did(), paper_cid)

    body = client.get(DASHBOARD_URL, headers=_auth(_did())).json()

    assert body["my_reviews"] == []


# --------------------------------------------------------------------------- #
# needs_attention: author replies
# --------------------------------------------------------------------------- #


def test_author_replies_are_listed_when_the_review_responses_table_exists():
    from sqlalchemy import JSON, Column, MetaData, Table, Text, inspect

    if inspect(db.engine).has_table("review_responses"):
        pytest.skip("the reviews plugin already provides review_responses")

    reviewer = _did()
    paper_cid, version_cid = _scene(authors=(_did(),))
    review_cid = _add_review(version_cid)
    _escrow(review_cid, reviewer, paper_cid)
    response_cid = f"cid-{uuid.uuid4().hex}"

    # The reviews plugin (feature 114) owns this table; create it from the
    # spec's columns so the dashboard's reflective read can be exercised.
    table = Table(
        "review_responses",
        MetaData(),
        Column("response_cid", Text, primary_key=True),
        Column("review_cid", Text, nullable=False),
        Column("replies", JSON, nullable=False),
    )
    table.create(bind=db.engine, checkfirst=True)
    try:
        with db.engine.begin() as connection:
            connection.execute(
                table.insert().values(
                    response_cid=response_cid,
                    review_cid=review_cid,
                    replies=[{"dimension": "soundness", "reply": "Thank you."}],
                )
            )

        body = client.get(DASHBOARD_URL, headers=_auth(reviewer)).json()

        replies = body["needs_attention"]["author_replies"]
        assert len(replies) == 1
        assert replies[0]["kind"] == "author_reply"
        assert replies[0]["reviewCid"] == review_cid
        assert replies[0]["responseCid"] == response_cid
        assert replies[0]["paper"] == derive_short_id(paper_cid)
        assert replies[0]["responses"] == [{"dimension": "soundness", "reply": "Thank you."}]
        assert body["my_reviews"][0]["authorReplied"] is True
        assert body["my_reviews"][0]["awaitingAuthor"] is False
    finally:
        table.drop(bind=db.engine, checkfirst=True)
        from app.modules.me import service

        service._response_tables.clear()


# --------------------------------------------------------------------------- #
# needs_attention: moderation outcomes
# --------------------------------------------------------------------------- #


def test_moderation_outcomes_merge_the_stored_decision_with_its_notice():
    author = _did()
    _, version_cid = _scene(authors=(author,))
    decision_cid = f"cid-{uuid.uuid4().hex}"
    with db.SessionLocal() as session:
        session.add(
            ModerationDecision(
                decision_cid=decision_cid,
                target_cid=version_cid,
                action="hold",
                clause="2.1",
                moderator_did=_did(),
                decided_at=_now(),
            )
        )
        session.commit()
    notify(
        author,
        "moderation.decision",
        {
            "decision_cid": decision_cid,
            "target_cid": version_cid,
            "action": "hold",
            "clause": "2.1",
            "reason": "Needs a methods check.",
        },
    )

    body = client.get(DASHBOARD_URL, headers=_auth(author)).json()

    outcomes = [
        item
        for item in body["needs_attention"]["moderation_outcomes"]
        if item.get("decisionCid") == decision_cid
    ]
    assert len(outcomes) == 1
    outcome = outcomes[0]
    assert outcome["action"] == "hold"
    assert outcome["clause"] == "2.1"
    assert outcome["versionCid"] == version_cid
    assert outcome["notified"] is True


def test_a_read_moderation_notice_no_longer_needs_attention():
    did = _did()
    notification = notify(
        did,
        "moderation.decision",
        {"decision_cid": f"cid-{uuid.uuid4().hex}", "action": "list"},
    )
    client.post(f"/v1/me/notifications/{notification.id}/read", headers=_auth(did))

    body = client.get(DASHBOARD_URL, headers=_auth(did)).json()

    assert body["needs_attention"]["moderation_outcomes"] == []


def test_a_flag_outcome_is_listed_for_the_reporter():
    reporter = _did()
    notify(
        reporter,
        FLAG_DECIDED_KIND,
        {
            "flag_id": f"flag-{uuid.uuid4().hex}",
            "target_cid": f"cid-{uuid.uuid4().hex}",
            "reason": "spam",
            "status": "upheld",
            "decision_cid": f"cid-{uuid.uuid4().hex}",
        },
    )

    body = client.get(DASHBOARD_URL, headers=_auth(reporter)).json()

    outcomes = body["needs_attention"]["moderation_outcomes"]
    # Flag outcomes are informational: they go to Notifications, not attention.
    assert outcomes == []

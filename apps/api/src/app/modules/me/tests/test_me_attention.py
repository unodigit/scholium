"""Regressions for "Needs your attention" (bug spec round 7a, item 2).

The dashboard's attention list must hold exactly the actions still open to the
caller, each naming the paper and linking to where the action is taken:

* a drawn appeal panellist is asked to vote, and stops being asked once they do;
* a hold is an appeal action until the author files their one appeal, and the
  moderator's reason is stated once rather than twice;
* a hidden post the caller wrote is appealable, with a working link;
* an author reply names the paper by title and stops being asked once the
  reviewer updates the review;
* an unverified email address is asked to be confirmed until it is verified.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from nacl.signing import SigningKey
from scholium_record_core import derive_short_id, did_key_from_signing_key, sign_record

from app import db
from app.modules import ledger
from app.modules.appeals.models import Appeal, AppealPanelMember
from app.modules.moderation.models import ModerationDecision
from app.modules.notifications import notify
from app.modules.profiles import ProfileData, save_profile
from app.modules.profiles.models import ProfileEmailVerification
from app.modules.reviews.models import Review, ReviewResponse
from app.modules.submissions import VersionAuthor, save_version

from .test_me_dashboard import (  # noqa: F401 - fixture re-exports
    DASHBOARD_URL,
    _add_review,
    _auth,
    _did,
    _escrow,
    _now,
    _scene,
    client,
)


def _items(did: str) -> list[dict]:
    response = client.get(DASHBOARD_URL, headers=_auth(did))
    assert response.status_code == 200
    return response.json()["needs_attention"]["items"]


def _store_decision(target_cid: str, action: str, **extra) -> str:
    decision_cid = f"cid-{uuid.uuid4().hex}"
    with db.SessionLocal() as session:
        session.add(
            ModerationDecision(
                decision_cid=decision_cid,
                target_cid=target_cid,
                action=action,
                clause="2.1",
                moderator_did=_did(),
                decided_at=_now(),
                **extra,
            )
        )
        session.commit()
    return decision_cid


def _file_appeal(decision_cid: str, appellant: str) -> str:
    appeal_cid = f"cid-{uuid.uuid4().hex}"
    with db.SessionLocal() as session:
        session.add(
            Appeal(
                appeal_cid=appeal_cid,
                decision_cid=decision_cid,
                appellant_did=appellant,
                grounds="The decision is wrong.",
                status="pending",
                filed_at=_now(),
            )
        )
        session.commit()
    return appeal_cid


# --------------------------------------------------------------------------- #
# A drawn panellist must vote
# --------------------------------------------------------------------------- #


def test_a_drawn_panellist_is_asked_to_vote_and_stops_once_they_do():
    panellist = _did()
    author = _did()
    paper_cid, version_cid = _scene(authors=(author,), title="A paper under appeal")
    decision_cid = _store_decision(version_cid, "hold")
    appeal_cid = _file_appeal(decision_cid, author)
    with db.SessionLocal() as session:
        session.add(AppealPanelMember(appeal_cid=appeal_cid, member_did=panellist, vote=None))
        session.commit()

    panel = [
        item for item in _items(panellist) if item.get("kind") == "appeal_panel"
    ]
    assert len(panel) == 1
    item = panel[0]
    assert "Vote on the appeal for" in item["summary"]
    assert "A paper under appeal" in item["summary"]
    # The form lives on /mod: a link that reaches it, not an API route.
    assert item["link"].startswith("/mod")
    assert item["paper"] == derive_short_id(paper_cid)
    assert item["appealCid"] == appeal_cid

    voted = client.post(
        f"/v1/appeals/{appeal_cid}/votes",
        json={"outcome": "upheld", "reasons": "The hold was correct."},
        headers=_auth(panellist, 3),
    )
    assert voted.status_code == 200, voted.text

    assert [item for item in _items(panellist) if item.get("kind") == "appeal_panel"] == []


# --------------------------------------------------------------------------- #
# A hold is an appeal action until the one appeal is filed
# --------------------------------------------------------------------------- #


def test_a_hold_is_an_appeal_action_with_a_link_until_the_appeal_is_filed():
    author = _did()
    paper_cid, version_cid = _scene(authors=(author,), title="A held paper")
    decision_cid = _store_decision(version_cid, "hold")

    items = [item for item in _items(author) if item.get("decisionCid") == decision_cid]
    assert len(items) == 1
    item = items[0]
    assert item["kind"] == "appeal_available"
    assert item["action"] == "hold"
    assert item["paper"] == derive_short_id(paper_cid)
    assert item["title"] == "A held paper"
    assert "A held paper" in item["summary"]
    assert item["link"] == f"/p/{derive_short_id(paper_cid)}"
    # The reason has its own field; the summary does not repeat it.
    assert item["summary"].count(".") == 1

    _file_appeal(decision_cid, author)

    assert [
        item for item in _items(author) if item.get("decisionCid") == decision_cid
    ] == []


def test_a_hidden_post_the_caller_wrote_is_appealable_with_a_link():
    author = _did()
    post_cid = f"cid-{uuid.uuid4().hex}"
    decision_cid = _store_decision(post_cid, "hide")
    link = "/discussion/sch:wrty-post-abcd"
    notify(
        author,
        "moderation.outcome",
        {
            "decision_cid": decision_cid,
            "target_cid": post_cid,
            "action": "hide",
            "target_kind": "post",
            "summary": "The post you wrote was hidden by moderation.",
            "link": link,
        },
    )

    items = [item for item in _items(author) if item.get("decisionCid") == decision_cid]
    assert len(items) == 1
    assert items[0]["kind"] == "appeal_available"
    assert items[0]["link"] == link
    assert "Appeal" in items[0]["summary"]

    _file_appeal(decision_cid, author)

    assert [
        item for item in _items(author) if item.get("decisionCid") == decision_cid
    ] == []


# --------------------------------------------------------------------------- #
# An author reply names the paper and ends when the review is updated
# --------------------------------------------------------------------------- #


def _add_review_response(review_cid: str) -> None:
    ReviewResponse.__table__.create(bind=db.engine, checkfirst=True)
    from app.modules.me import service

    service._response_tables.clear()
    with db.SessionLocal() as session:
        session.add(
            ReviewResponse(
                response_cid=f"cid-{uuid.uuid4().hex}",
                review_cid=review_cid,
                replies=[{"dimension": "soundness", "reply": "Thank you."}],
            )
        )
        session.commit()


def _reviewer_update(review: Review, version_cid: str, seed: SigningKey) -> None:
    """Append the reviewer's ``review.formal`` update, signed with their key."""
    if not review.review_key.startswith("did:key:"):
        review_key = did_key_from_signing_key(seed)
        with db.SessionLocal() as session:
            row = session.get(Review, review.review_cid)
            row.review_key = review_key
            session.commit()
    else:
        review_key = review.review_key
    record = sign_record(
        {
            "v": 1,
            "type": "review.formal",
            "author": review_key,
            "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "prev": None,
            "body": {"target": version_cid, "commitment": uuid.uuid4().hex},
            "proofs": [],
        },
        seed,
    )
    ledger.append(record)


def test_an_author_reply_names_the_paper_and_ends_when_the_review_is_updated():
    reviewer = _did()
    paper_cid, version_cid = _scene(authors=(_did(),), title="A reviewed paper")
    review_cid = _add_review(version_cid)
    _escrow(review_cid, reviewer, paper_cid)
    _add_review_response(review_cid)

    replies = [
        item for item in _items(reviewer) if item.get("kind") == "author_reply"
    ]
    assert len(replies) == 1
    assert "A reviewed paper" in replies[0]["summary"]
    assert derive_short_id(paper_cid) not in replies[0]["summary"]

    next_version = f"cid-{uuid.uuid4().hex}"
    save_version(
        version_cid=next_version,
        paper_cid=paper_cid,
        n=2,
        title="A reviewed paper",
        abstract="",
        manifest_cid=f"bafkreimanifest{uuid.uuid4().hex}",
        licence="CC-BY-4.0",
        prev_cid=version_cid,
        authors=(VersionAuthor(_did(), 1, ("Conceptualization",)),),
        state="listed",
    )
    seed = SigningKey.generate()
    with db.SessionLocal() as session:
        review = session.get(Review, review_cid)
        session.expunge(review)
    _reviewer_update(review, next_version, seed)

    assert [
        item for item in _items(reviewer) if item.get("kind") == "author_reply"
    ] == []


# --------------------------------------------------------------------------- #
# An unverified email address is an action until it is verified
# --------------------------------------------------------------------------- #


def test_an_unverified_email_is_an_action_until_it_is_verified():
    did = _did()
    save_profile(
        did,
        ProfileData(name="Ana Costa", affiliation="", email="ana@example.org"),
    )
    link = f"/verify-email?did={did}&token=abc"
    notify(did, "email.verify", {"email": "ana@example.org", "link": link, "did": did})

    items = [
        item for item in _items(did) if item.get("kind") == "email_verification"
    ]
    assert len(items) == 1
    assert items[0]["link"] == link
    assert "Confirm your email address" in items[0]["summary"]

    with db.SessionLocal() as session:
        row = session.get(ProfileEmailVerification, did)
        assert row is not None
        row.verified_at = _now()
        session.commit()

    assert [
        item for item in _items(did) if item.get("kind") == "email_verification"
    ] == []

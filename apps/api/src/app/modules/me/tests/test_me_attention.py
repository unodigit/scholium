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
from app.modules.submissions import (
    AWAITING_CONSENT,
    VersionAuthor,
    save_paper,
    save_version,
)

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


def _ledger_post(version_cid: str, paper_cid: str, text: str) -> str:
    """A signed ``discussion.post`` in the log, with ``text`` as its body."""
    seed = SigningKey.generate()
    record = sign_record(
        {
            "v": 1,
            "type": "discussion.post",
            "author": did_key_from_signing_key(seed),
            "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "prev": None,
            "body": {
                "target": version_cid,
                "anchor": version_cid,
                "text": text,
                "parent": None,
                "paper": paper_cid,
            },
            "proofs": [],
        },
        seed,
    )
    ledger.append(record)
    return record["id"]


def _paper_with_genesis(title: str, author: str) -> tuple[str, str]:
    """A paper and its first version, with the signed genesis in the ledger.

    ``_scene`` indexes a genesis the log does not hold; the outcome sentence
    reads the paper's title from the log, so this scene appends it.
    """
    seed = SigningKey.generate()
    record = sign_record(
        {
            "v": 1,
            "type": "paper.genesis",
            "author": did_key_from_signing_key(seed),
            "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "prev": None,
            "body": {
                "seed": uuid.uuid4().hex,
                "title": title,
                "abstract": "",
                "categories": ["cs.CR"],
                "licence": "CC-BY-4.0",
                "authors": [did_key_from_signing_key(seed)],
            },
            "proofs": [],
        },
        seed,
    )
    ledger.append(record)
    paper_cid = record["id"]
    save_paper(paper_cid=paper_cid, categories=("cs.CR",))
    version_cid = f"cid-{uuid.uuid4().hex}"
    save_version(
        version_cid=version_cid,
        paper_cid=paper_cid,
        n=1,
        title=title,
        abstract="",
        manifest_cid=f"bafkreimanifest{uuid.uuid4().hex}",
        licence="CC-BY-4.0",
        prev_cid=paper_cid,
        authors=(VersionAuthor(author, 1, ("Conceptualization",)),),
        state=AWAITING_CONSENT,
    )
    return paper_cid, version_cid


def _hide_notice(author: str, target_cid: str, decision_cid: str) -> None:
    """The outcome notice a hidden record's author receives."""
    notify(
        author,
        "moderation.outcome",
        {
            "decision_cid": decision_cid,
            "target_cid": target_cid,
            "action": "hide",
            "target_kind": "post",
            "summary": "The post you wrote was hidden by moderation.",
            "link": "/discussion/sch:wrty-post-abcd",
        },
    )


def test_two_hidden_posts_on_one_paper_read_as_two_different_appeals():
    author = _did()
    paper_cid, version_cid = _paper_with_genesis(
        "Can a Meta-Agent Choose the Safer Branch?", author
    )
    first = _ledger_post(
        version_cid, paper_cid, "Sweep 20 first thread: the moderation placeholder."
    )
    second = _ledger_post(
        version_cid, paper_cid, "Sweep 20 second thread: a different reply, hidden too."
    )
    for post_cid in (first, second):
        _hide_notice(author, post_cid, _store_decision(post_cid, "hide"))

    items = [
        item
        for item in _items(author)
        if item.get("kind") == "appeal_available" and item.get("action") == "hide"
    ]
    assert len(items) == 2
    # Each item quotes the post it is about, so the two are told apart.
    assert {item["summary"] for item in items} == {
        'Appeal the removal of your post ("Sweep 20 first thread: the moderation '
        'placeholder...") on "Can a Meta-Agent Choose the Safer Branch?".',
        'Appeal the removal of your post ("Sweep 20 second thread: a different reply, '
        'hidden too...") on "Can a Meta-Agent Choose the Safer Branch?".',
    }


def test_a_hidden_post_this_node_cannot_read_keeps_the_plain_sentence():
    author = _did()
    post_cid = f"cid-{uuid.uuid4().hex}"
    _hide_notice(author, post_cid, _store_decision(post_cid, "hide"))

    items = [
        item
        for item in _items(author)
        if item.get("kind") == "appeal_available" and item.get("action") == "hide"
    ]
    assert len(items) == 1
    assert items[0]["summary"] == "Appeal the removal of your post."


def test_a_hidden_post_with_no_readable_excerpt_keeps_the_title_only_sentence():
    author = _did()
    paper_cid, version_cid = _paper_with_genesis("A paper with a hidden post", author)
    # A record whose body carries no text: the paper is readable, the opening is not.
    seed = SigningKey.generate()
    record = sign_record(
        {
            "v": 1,
            "type": "discussion.post",
            "author": did_key_from_signing_key(seed),
            "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "prev": None,
            "body": {"target": version_cid, "paper": paper_cid, "parent": None},
            "proofs": [],
        },
        seed,
    )
    ledger.append(record)
    post_cid = record["id"]
    _hide_notice(author, post_cid, _store_decision(post_cid, "hide"))

    items = [
        item
        for item in _items(author)
        if item.get("kind") == "appeal_available" and item.get("action") == "hide"
    ]
    assert len(items) == 1
    assert items[0]["summary"] == (
        'Appeal the removal of your post on "A paper with a hidden post".'
    )


def test_a_hidden_review_quotes_its_report():
    author = _did()
    _paper_cid, version_cid = _paper_with_genesis("A reviewed paper", author)
    seed = SigningKey.generate()
    record = sign_record(
        {
            "v": 1,
            "type": "review.formal",
            "author": did_key_from_signing_key(seed),
            "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "prev": None,
            "body": {
                "target": version_cid,
                "report": "The method is sound, but the claims are too strong.",
                "commitment": uuid.uuid4().hex,
            },
            "proofs": [],
        },
        seed,
    )
    ledger.append(record)
    review_cid = record["id"]
    decision_cid = _store_decision(review_cid, "hide")
    notify(
        author,
        "moderation.outcome",
        {
            "decision_cid": decision_cid,
            "target_cid": review_cid,
            "action": "hide",
            "target_kind": "review",
            "link": "/reviews/sch:wrty-paper-abcd",
        },
    )

    items = [item for item in _items(author) if item.get("decisionCid") == decision_cid]
    assert len(items) == 1
    # The report is quoted; this node cannot read the version's title from the
    # log in this scene, and a missing title never suppresses the quote.
    assert items[0]["summary"] == (
        'Appeal the removal of your review ("The method is sound, but the claims '
        'are too strong...").'
    )


def test_hold_and_reject_items_keep_their_plain_wording():
    author = _did()
    _held_paper, held_version = _paper_with_genesis("A held paper", author)
    _rejected_paper, rejected_version = _paper_with_genesis("A rejected paper", author)
    hold_cid = _store_decision(held_version, "hold")
    reject_cid = _store_decision(rejected_version, "reject")

    summaries = {
        item["decisionCid"]: item["summary"]
        for item in _items(author)
        if item.get("kind") == "appeal_available"
    }
    assert summaries[hold_cid] == 'Appeal the hold on "A held paper".'
    assert summaries[reject_cid] == 'Appeal the rejection of "A rejected paper".'


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

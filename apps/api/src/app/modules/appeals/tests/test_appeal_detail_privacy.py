"""Regression: the public appeal detail must not leak hidden or sealed content.

``GET /v1/appeals/{cid}`` needs no token, and it used to return ``excerpt`` and
``target_link`` -- the opening of a discussion post or of a formal review's
report, read straight from the ledger -- to every reader.  So anybody who knew an
appeal id could read the start of a post a moderator hid, and, for an appeal on
a decision about a formal review, the report before the reviews listing would
serve it ("a sealed report stays out").

The rules these tests hold:

* ``excerpt`` and ``target_link`` are filled only for a caller who may judge or
  contest the decision: a member seated on the appeal's panel, a tier-4
  moderator, or the appellant.  Every other caller, a caller with no token
  included, gets ``null`` for both;
* whatever the caller, a formal review's report excerpt is withheld while that
  version's report gate is closed, unless the caller is a tier-4 moderator or the
  review's author;
* the appeal stays a public record: what it says, and what the public decision
  record already names, is returned to every reader as before.
"""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from scholium_record_core import sign_record, verify_record

from app import db
from app.modules.moderation.tests.test_decisions import (
    DECISIONS_URL,
    Moderator,
    Submission,
    _timestamp,
)
from app.modules.moderation.tests.test_record_decisions import (
    RecordAuthor,
    _revealed_review,
    decide_on,
)
from app.modules.reviews.models import Review, ensure_tables as ensure_review_tables

from .test_appeal_panels import _account, client  # noqa: F401 - fixture re-export
from .test_appeal_polish import (  # noqa: F401 - ``pool`` is a fixture
    HiddenPost,
    _bearer,
    _detail,
    _PaperAuthor,
    _seat_pool,
    pool,
)
from .test_appeals import APPEALS_URL, node_key, subscribed  # noqa: F401 - autouse fixtures

#: What the public decision record already names, so the appeal keeps returning it.
PUBLIC_SUBJECT_FIELDS = (
    "target_cid",
    "target_kind",
    "record_type",
    "paper_title",
    "decision_action",
)


def _file_appeal(client, decision_cid: str, paper_cid: str, appellant) -> dict:
    record = sign_record(
        {
            "v": 1,
            "type": "appeal",
            "author": appellant.did,
            "created": _timestamp(),
            "prev": None,
            "body": {
                "target": decision_cid,
                "grounds": f"Unfair {uuid.uuid4().hex}",
                "paper": paper_cid,
            },
            "proofs": [],
        },
        appellant.seed,
    )
    assert verify_record(record)
    response = client.post(APPEALS_URL, json=record, headers=_bearer(appellant.did, 3))
    assert response.status_code == 201, response.text
    return record


def _commit_review(
    submission: Submission,
    key_holder: RecordAuthor,
    *,
    signed_by: Optional[str] = None,
    committed_days_ago: int = 0,
) -> None:
    """A revealed ``review`` row on ``submission``'s version: one review the gate counts."""
    ensure_review_tables()
    committed = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(
        days=committed_days_ago
    )
    with db.SessionLocal() as session:
        session.add(
            Review(
                review_cid=f"bafy-review-{uuid.uuid4().hex}",
                version_cid=submission.version_cid,
                review_key=key_holder.did,
                nullifier=os.urandom(32),
                signed_by=signed_by,
                committed_at=committed,
                revealed_at=committed,
            )
        )
        session.commit()


class HiddenReview:
    """A formal review a moderator hid, and the appeal against that decision.

    The review's gate is closed: no other review is counted on its version and
    the first one was committed just now.  ``reviewer`` is the account that signed
    the review with their name; the record itself is signed by a review key.
    """

    def __init__(self, client, *, signed: bool = True) -> None:
        self.client = client
        self.submission = Submission(state="listed")
        self.reviewer = RecordAuthor()
        self.key_holder = RecordAuthor()
        _account(3, self.reviewer.did)
        self.review = _revealed_review(self.key_holder, self.submission)
        _commit_review(
            self.submission,
            self.key_holder,
            signed_by=self.reviewer.did if signed else None,
        )
        self.moderator = Moderator()
        _account(4, self.moderator.did)
        decision = decide_on(self.moderator, self.review["id"], "hide")
        response = client.post(DECISIONS_URL, json=decision, headers=self.moderator.headers)
        assert response.status_code == 201, response.text
        self.decision_cid: str = decision["id"]

    @property
    def report(self) -> str:
        return self.review["body"]["report"]

    def appeal(self, appellant) -> dict:
        return _file_appeal(self.client, self.decision_cid, self.submission.paper_cid, appellant)

    def open_the_gate(self) -> None:
        """A second review on the version opens its report gate (REV-4)."""
        _commit_review(self.submission, RecordAuthor())


def _stranger() -> str:
    """A signed-in member with no part in the appeal."""
    return _account(3)


def _public_fields(body: dict) -> dict:
    return {key: body[key] for key in PUBLIC_SUBJECT_FIELDS}


# --------------------------------------------------------------------------- #
# A hidden post
# --------------------------------------------------------------------------- #


def test_an_anonymous_reader_gets_no_excerpt_or_link_of_a_hidden_post(client, pool):
    scene = HiddenPost(client)
    pool(*_seat_pool()[:3])
    record = scene.appeal()

    body = _detail(client, record["id"], None)

    assert body["excerpt"] is None
    assert body["target_link"] is None
    assert scene.text not in str(body)


def test_an_unrelated_signed_in_reader_gets_no_excerpt_or_link_of_a_hidden_post(client, pool):
    scene = HiddenPost(client)
    pool(*_seat_pool()[:3])
    record = scene.appeal()

    body = _detail(client, record["id"], _stranger())

    assert body["excerpt"] is None
    assert body["target_link"] is None
    assert scene.text not in str(body)


def test_a_seated_member_reads_the_excerpt_and_link_of_a_hidden_post(client, pool):
    scene = HiddenPost(client)
    seated = _seat_pool()[:3]
    pool(*seated)
    record = scene.appeal()

    body = _detail(client, record["id"], seated[0])

    assert body["viewer_on_panel"] is True
    assert body["excerpt"] == scene.text
    assert body["target_link"].startswith("/discussion/sch:")


def test_a_moderator_reads_the_excerpt_and_link_of_a_hidden_post(client, pool):
    scene = HiddenPost(client)
    pool(*_seat_pool()[:3])
    record = scene.appeal()

    body = _detail(client, record["id"], scene.moderator.did, 4)

    assert body["excerpt"] == scene.text
    assert body["target_link"].startswith("/discussion/sch:")


def test_the_appellant_reads_the_excerpt_and_link_of_a_hidden_post(client, pool):
    scene = HiddenPost(client)
    pool(*_seat_pool()[:3])
    record = scene.appeal()

    body = _detail(client, record["id"], scene.post_author.did)

    assert body["excerpt"] == scene.text
    assert body["target_link"].startswith("/discussion/sch:")


def test_a_tier_below_four_does_not_make_a_moderator(client, pool):
    """A tier-3 reader who is not seated and did not appeal is a stranger, whatever the tier."""
    scene = HiddenPost(client)
    pool(*_seat_pool()[:3])
    record = scene.appeal()

    body = _detail(client, record["id"], scene.moderator.did, 3)

    assert body["excerpt"] is None
    assert body["target_link"] is None


def test_the_appeal_stays_a_public_record_for_every_reader(client, pool):
    scene = HiddenPost(client)
    pool(*_seat_pool()[:3])
    record = scene.appeal()

    for did in (None, _stranger()):
        body = _detail(client, record["id"], did)

        assert body["id"] == record["id"]
        assert body["decision"] == scene.decision_cid
        assert body["appellant"] == scene.post_author.did
        assert body["grounds"] == record["body"]["grounds"]
        assert body["status"] == "pending"
        assert body["filed_at"]
        assert body["deadline"]
        assert _public_fields(body) == {
            "target_cid": scene.post["id"],
            "target_kind": "post",
            "record_type": "discussion.post",
            "paper_title": scene.title,
            "decision_action": "hide",
        }


def test_the_panel_stays_visible_only_to_the_seated_and_to_moderators(client, pool):
    scene = HiddenPost(client)
    seated = _seat_pool()[:3]
    pool(*seated)
    record = scene.appeal()

    assert _detail(client, record["id"], None)["panel"] == []
    assert _detail(client, record["id"], _stranger())["panel"] == []
    # The appellant is not a seat holder: their view of the panel is unchanged.
    assert _detail(client, record["id"], scene.post_author.did)["panel"] == []
    assert len(_detail(client, record["id"], seated[0])["panel"]) == 3
    assert len(_detail(client, record["id"], scene.moderator.did, 4)["panel"]) == 3


# --------------------------------------------------------------------------- #
# A formal review whose report is still sealed
# --------------------------------------------------------------------------- #


def test_an_anonymous_reader_gets_no_excerpt_or_link_of_a_sealed_review(client, pool):
    scene = HiddenReview(client)
    pool(*_seat_pool()[:3])
    record = scene.appeal(_PaperAuthor(scene.submission))

    body = _detail(client, record["id"], None)

    assert body["excerpt"] is None
    assert body["target_link"] is None
    assert scene.report not in str(body)


def test_an_unrelated_signed_in_reader_gets_no_excerpt_or_link_of_a_sealed_review(client, pool):
    scene = HiddenReview(client)
    pool(*_seat_pool()[:3])
    record = scene.appeal(_PaperAuthor(scene.submission))

    body = _detail(client, record["id"], _stranger())

    assert body["excerpt"] is None
    assert body["target_link"] is None
    assert scene.report not in str(body)


def test_a_seated_member_gets_no_excerpt_of_a_sealed_review_but_still_the_link(client, pool):
    scene = HiddenReview(client)
    seated = _seat_pool()[:3]
    pool(*seated)
    record = scene.appeal(_PaperAuthor(scene.submission))

    body = _detail(client, record["id"], seated[0])

    assert body["viewer_on_panel"] is True
    assert body["excerpt"] is None
    assert body["target_link"].startswith("/reviews/sch:")
    assert scene.report not in str(body)


def test_the_appellant_gets_no_excerpt_of_a_sealed_review_when_not_its_author(client, pool):
    scene = HiddenReview(client)
    pool(*_seat_pool()[:3])
    paper_author = _PaperAuthor(scene.submission)
    record = scene.appeal(paper_author)

    body = _detail(client, record["id"], paper_author.did)

    assert body["excerpt"] is None
    assert body["target_link"].startswith("/reviews/sch:")
    assert scene.report not in str(body)


def test_a_moderator_reads_the_excerpt_of_a_sealed_review(client, pool):
    scene = HiddenReview(client)
    pool(*_seat_pool()[:3])
    record = scene.appeal(_PaperAuthor(scene.submission))

    body = _detail(client, record["id"], scene.moderator.did, 4)

    assert body["excerpt"] == scene.report
    assert body["target_link"].startswith("/reviews/sch:")


def test_the_reviews_author_who_appeals_reads_the_excerpt_of_a_sealed_review(client, pool):
    scene = HiddenReview(client)
    pool(*_seat_pool()[:3])
    record = scene.appeal(scene.reviewer)

    body = _detail(client, record["id"], scene.reviewer.did)

    assert body["excerpt"] == scene.report
    assert body["target_link"].startswith("/reviews/sch:")


def test_an_anonymous_review_has_no_author_who_could_read_it_while_sealed(client, pool):
    """No account is tied to the review, so only a moderator may read the sealed report."""
    scene = HiddenReview(client, signed=False)
    pool(*_seat_pool()[:3])
    record = scene.appeal(_PaperAuthor(scene.submission))

    assert _detail(client, record["id"], _PaperAuthor(scene.submission).did)["excerpt"] is None
    assert _detail(client, record["id"], scene.key_holder.did)["excerpt"] is None
    assert _detail(client, record["id"], scene.moderator.did, 4)["excerpt"] == scene.report


def test_the_excerpt_of_a_review_is_served_to_those_who_may_see_it_once_the_gate_opens(
    client, pool
):
    scene = HiddenReview(client)
    seated = _seat_pool()[:3]
    pool(*seated)
    paper_author = _PaperAuthor(scene.submission)
    record = scene.appeal(paper_author)
    scene.open_the_gate()

    assert _detail(client, record["id"], seated[0])["excerpt"] == scene.report
    assert _detail(client, record["id"], paper_author.did)["excerpt"] == scene.report
    assert _detail(client, record["id"], scene.moderator.did, 4)["excerpt"] == scene.report
    # An open gate does not make the hidden review's opening public.
    assert _detail(client, record["id"], None)["excerpt"] is None
    assert _detail(client, record["id"], None)["target_link"] is None
    assert _detail(client, record["id"], _stranger())["excerpt"] is None


def test_the_gate_opens_twenty_one_days_after_the_first_review(client, pool):
    scene = HiddenReview(client)
    seated = _seat_pool()[:3]
    pool(*seated)
    record = scene.appeal(_PaperAuthor(scene.submission))

    assert _detail(client, record["id"], seated[0])["excerpt"] is None

    with db.SessionLocal() as session:
        for row in session.query(Review).filter(Review.version_cid == scene.submission.version_cid):
            row.committed_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=22)
        session.commit()

    assert _detail(client, record["id"], seated[0])["excerpt"] == scene.report


def test_a_gate_that_cannot_be_read_counts_as_closed(client, pool, monkeypatch):
    from app.modules.appeals import subject as subject_module

    def broken(version_cid: str) -> bool:
        raise RuntimeError("the reviews tables are unreadable")

    scene = HiddenReview(client)
    seated = _seat_pool()[:3]
    pool(*seated)
    record = scene.appeal(_PaperAuthor(scene.submission))
    scene.open_the_gate()
    monkeypatch.setattr(subject_module, "_report_gate_open", broken)

    assert _detail(client, record["id"], seated[0])["excerpt"] is None
    # A moderator reads a sealed report anyway, so the gate is not asked.
    assert _detail(client, record["id"], scene.moderator.did, 4)["excerpt"] == scene.report


def test_the_appeal_of_a_sealed_review_stays_a_public_record(client, pool):
    scene = HiddenReview(client)
    pool(*_seat_pool()[:3])
    paper_author = _PaperAuthor(scene.submission)
    record = scene.appeal(paper_author)

    for did in (None, _stranger()):
        body = _detail(client, record["id"], did)

        assert body["id"] == record["id"]
        assert body["decision"] == scene.decision_cid
        assert body["appellant"] == paper_author.did
        assert body["status"] == "pending"
        assert _public_fields(body) == {
            "target_cid": scene.review["id"],
            "target_kind": "review",
            "record_type": "review.formal",
            "paper_title": scene.submission.title,
            "decision_action": "hide",
        }

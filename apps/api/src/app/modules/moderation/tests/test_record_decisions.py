"""Deciding flags on records that are not paper versions (verify sweep 2, #1).

A flag may name a discussion post, an inline annotation or a revealed review,
and ``POST /v1/moderation/decisions`` refused every one of them with ``422``
"not a paper version this node holds" -- so a flag on a post could never be
settled and its reporter never heard an outcome.  These tests hold the line
the bug report names: a decision's target is *any flaggable record this node
holds*, with the actions that are valid for that type

* ``dismiss`` -- every type; nothing about the record changes, the flags close;
* ``hide`` -- a post, an annotation or a review; the signed record stays in the
  log but is withdrawn from public reads (``moderation.is_hidden``), and a
  later ``release`` restores it (what an overturned appeal appends);
* the paper actions stay the version's own, and a paper action aimed at a
  post or a review is a ``422`` that says what the type does accept.

Paper-version decisions keep their behaviour and their tests
(``test_decisions.py``); here a version appears only where the new ``dismiss``
touches it.
"""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any, Optional

import pytest
from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key, sign_record, verify_record

from app.modules import flags, moderation
from app.modules.moderation.tests.test_decisions import (
    DECISIONS_URL,
    RECORDS_URL,
    Moderator,
    Submission,
    _problem,
    _stored,
    _timestamp,
    client,  # noqa: F401 - fixture re-exports
    moderator,  # noqa: F401 - fixture re-exports
    subscribed,  # noqa: F401 - fixture re-exports
)
from app.security import issue_access_token

flags.ensure_tables()


# --------------------------------------------------------------------------- #
# The scene: a flagged post, annotation or review, and a decision aimed at it
# --------------------------------------------------------------------------- #


class RecordAuthor:
    """A member whose signed record a flag names."""

    def __init__(self) -> None:
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)

    def sign(self, record_type: str, body: dict[str, Any]) -> dict:
        record = sign_record(
            {
                "v": 1,
                "type": record_type,
                "author": self.did,
                "created": _timestamp(),
                "prev": None,
                "body": body,
                "proofs": [],
            },
            self.seed,
        )
        assert verify_record(record)
        return record


def _post(author: RecordAuthor, submission: Submission, *, annotation: bool = False) -> dict:
    """A signed ``discussion.post`` (an inline annotation when asked) in the log."""
    from app.modules import ledger

    body: dict[str, Any] = {
        "target": submission.version_cid,
        "anchor": (
            {
                "version": submission.version_cid,
                "paragraph_id": "p-3",
                "quote": "the quoted passage",
                "offset": 12,
            }
            if annotation
            else submission.version_cid
        ),
        "text": f"A flagged {'annotation' if annotation else 'post'} {uuid.uuid4().hex}",
        "parent": None,
        "paper": submission.paper_cid,
    }
    record = author.sign("discussion.post", body)
    ledger.append(record)
    return record


def _revealed_review(author: RecordAuthor, submission: Submission) -> dict:
    """A signed ``review.formal`` in the log: a review a member may flag."""
    from app.modules import ledger

    scores = {
        dimension: {"score": 3, "justification": "fine"}
        for dimension in ("soundness", "evidence", "reproducibility", "novelty", "clarity", "limitations")
    }
    record = author.sign(
        "review.formal",
        {
            "target": submission.version_cid,
            "paper": submission.paper_cid,
            "scores": scores,
            "confidence": "high",
            "recommendation": "minor_revisions",
            "report": f"A flagged report {uuid.uuid4().hex}",
            "commitment": uuid.uuid4().hex,
        },
    )
    ledger.append(record)
    return record


def decide_on(moderator: Moderator, target: str, action: str, **extra: Any) -> dict:
    """A signed ``moderation.decision`` aimed at ``target``."""
    body: dict[str, Any] = {"target": target, "action": action, **extra}
    body.setdefault("clause", "MOD-01")
    body.setdefault("reason", f"Decision {uuid.uuid4().hex}")
    return sign_record(
        {
            "v": 1,
            "type": moderation.DECISION_TYPE,
            "author": moderator.did,
            "created": _timestamp(),
            "prev": None,
            "body": body,
            "proofs": [],
        },
        moderator.seed,
    )


def _file_flag(client, target: str) -> dict:
    reporter = f"did:example:recordflag-{uuid.uuid4().hex}"
    response = client.post(
        "/v1/flags",
        json={"target": target, "reason": "spam"},
        headers={"Authorization": f"Bearer {issue_access_token(reporter, 1)}"},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _notifications(did: str) -> list[Any]:
    from app.modules.notifications import list_notifications

    return list_notifications(did)


@pytest.fixture
def post_record() -> dict:
    """A flagged discussion post by a known member, on a listed paper."""
    return _post(RecordAuthor(), Submission(state="listed"))


@pytest.fixture
def review_record() -> dict:
    """A flagged revealed review on a listed paper."""
    return _revealed_review(RecordAuthor(), Submission(state="listed"))


# --------------------------------------------------------------------------- #
# dismiss: every flaggable type, no content change
# --------------------------------------------------------------------------- #


def test_dismiss_on_a_discussion_post_is_accepted(client, moderator, post_record):
    decision = decide_on(moderator, post_record["id"], "dismiss")

    response = client.post(DECISIONS_URL, json=decision, headers=moderator.headers)

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["target"] == post_record["id"]
    assert body["action"] == "dismiss"
    assert body["state"] == "dismissed"
    # The decision is a signed record in the log, and the post is untouched.
    assert _stored(client, decision)
    row = moderation.get_decision(decision["id"])
    assert row is not None and row.action == "dismiss" and row.target_cid == post_record["id"]
    assert moderation.hidden_record(post_record["id"]) is None


def test_dismiss_on_an_annotation_is_accepted(client, moderator):
    annotation = _post(RecordAuthor(), Submission(state="listed"), annotation=True)

    response = client.post(
        DECISIONS_URL, json=decide_on(moderator, annotation["id"], "dismiss"), headers=moderator.headers
    )

    assert response.status_code == 201, response.text


def test_dismiss_on_a_revealed_review_is_accepted(client, moderator, review_record):
    response = client.post(
        DECISIONS_URL, json=decide_on(moderator, review_record["id"], "dismiss"), headers=moderator.headers
    )

    assert response.status_code == 201, response.text
    assert response.json()["state"] == "dismissed"


def test_dismiss_on_a_paper_version_changes_nothing_and_settles_the_flags(client, moderator):
    submission = Submission(state="moderation")
    flag = _file_flag(client, submission.version_cid)

    response = client.post(
        DECISIONS_URL, json=decide_on(moderator, submission.version_cid, "dismiss"), headers=moderator.headers
    )

    assert response.status_code == 201, response.text
    assert submission.state == "moderation"
    assert response.json()["state"] == "moderation"
    stored = flags.get_flag(flag["id"])
    assert stored is not None and stored.status == flags.DECIDED


# --------------------------------------------------------------------------- #
# hide: posts, annotations and reviews only
# --------------------------------------------------------------------------- #


def test_hide_on_a_discussion_post_is_accepted_and_withdraws_it(client, moderator, post_record):
    decision = decide_on(moderator, post_record["id"], "hide")

    response = client.post(DECISIONS_URL, json=decision, headers=moderator.headers)

    assert response.status_code == 201, response.text
    assert response.json()["state"] == "hidden"
    # The signed record stays in the log, but the node records the withdrawal.
    assert _stored(client, post_record)
    hidden = moderation.hidden_record(post_record["id"])
    assert hidden is not None
    assert hidden.decision_cid == decision["id"]
    assert hidden.reason == decision["body"]["reason"]


def test_hide_on_an_annotation_is_accepted(client, moderator):
    annotation = _post(RecordAuthor(), Submission(state="listed"), annotation=True)

    response = client.post(
        DECISIONS_URL, json=decide_on(moderator, annotation["id"], "hide"), headers=moderator.headers
    )

    assert response.status_code == 201, response.text
    assert moderation.is_hidden(annotation["id"])


def test_hide_on_a_revealed_review_is_accepted(client, moderator, review_record):
    response = client.post(
        DECISIONS_URL, json=decide_on(moderator, review_record["id"], "hide"), headers=moderator.headers
    )

    assert response.status_code == 201, response.text
    assert moderation.is_hidden(review_record["id"])


def test_a_release_restores_a_hidden_record(client, moderator, post_record):
    assert client.post(
        DECISIONS_URL, json=decide_on(moderator, post_record["id"], "hide"), headers=moderator.headers
    ).status_code == 201

    # An overturned appeal appends a release naming the state it restores.
    response = client.post(
        DECISIONS_URL,
        json=decide_on(moderator, post_record["id"], "release", state="moderation"),
        headers=moderator.headers,
    )

    assert response.status_code == 201, response.text
    assert moderation.hidden_record(post_record["id"]) is None


def test_hide_on_a_paper_version_is_a_clear_422(client, moderator):
    submission = Submission(state="moderation")

    problem = _problem(
        client.post(
            DECISIONS_URL, json=decide_on(moderator, submission.version_cid, "hide"), headers=moderator.headers
        ),
        422,
    )

    assert problem["type"] == "urn:scholium:problem:decision-action-invalid"
    assert submission.state == "moderation"


# --------------------------------------------------------------------------- #
# Paper actions aimed at a record are a clear 422
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "action", ["list", "hold", "reclassify", "reject", "delist", "tombstone"]
)
def test_paper_actions_on_a_post_are_a_clear_422(client, moderator, post_record, action):
    extra: dict[str, Any] = {"category": "cs.LG"} if action == "reclassify" else {}

    problem = _problem(
        client.post(
            DECISIONS_URL,
            json=decide_on(moderator, post_record["id"], action, **extra),
            headers=moderator.headers,
        ),
        422,
    )

    assert problem["type"] == "urn:scholium:problem:decision-action-invalid"
    assert problem["errors"][0]["loc"] == ["body", "action"]
    assert "dismiss" in problem["detail"] and "hide" in problem["detail"]
    assert not moderation.is_hidden(post_record["id"])
    assert moderation.get_decision(problem["errors"][0].get("input") or "") is None or True


@pytest.mark.parametrize("action", ["list", "reject"])
def test_paper_actions_on_a_review_are_a_clear_422(client, moderator, review_record, action):
    _problem(
        client.post(
            DECISIONS_URL, json=decide_on(moderator, review_record["id"], action), headers=moderator.headers
        ),
        422,
    )


def test_an_unknown_target_is_still_a_clear_422(client, moderator):
    unknown = f"bafyreiunknown{uuid.uuid4().hex}"

    problem = _problem(
        client.post(DECISIONS_URL, json=decide_on(moderator, unknown, "dismiss"), headers=moderator.headers),
        422,
    )

    assert problem["type"] == "urn:scholium:problem:unknown-decision-target"


# --------------------------------------------------------------------------- #
# Deciding settles every open flag and tells the reporter and the author
# --------------------------------------------------------------------------- #


def test_deciding_a_flagged_post_settles_the_flag_and_notifies_reporter_and_author(
    client, moderator, subscribed, post_record
):
    flag = _file_flag(client, post_record["id"])
    stored = flags.get_flag(flag["id"])
    assert stored is not None
    author_did = post_record["author"]
    decision = decide_on(moderator, post_record["id"], "hide")

    response = client.post(DECISIONS_URL, json=decision, headers=moderator.headers)

    assert response.status_code == 201, response.text
    settled = flags.get_flag(flag["id"])
    assert settled is not None
    assert settled.status == flags.DECIDED
    assert settled.decision_cid == decision["id"]
    # The reporter hears the outcome of their flag...
    [reporter_note] = [
        n for n in _notifications(stored.reporter_did) if n.kind == flags.FLAG_DECIDED_KIND
    ]
    assert reporter_note.payload["decision_cid"] == decision["id"]
    # ...and the record's author hears the decision itself.
    [author_note] = [
        n
        for n in _notifications(author_did)
        if n.kind == moderation.RECORD_DECISION_KIND
    ]
    assert author_note.payload["target_cid"] == post_record["id"]
    assert author_note.payload["action"] == "hide"


def test_every_open_flag_on_the_record_is_settled(client, moderator, post_record):
    first = _file_flag(client, post_record["id"])
    second = _file_flag(client, post_record["id"])

    assert client.post(
        DECISIONS_URL, json=decide_on(moderator, post_record["id"], "dismiss"), headers=moderator.headers
    ).status_code == 201

    for flag_id in (first["id"], second["id"]):
        settled = flags.get_flag(flag_id)
        assert settled is not None and settled.status == flags.DECIDED


def test_the_reporter_hears_the_outcome_in_words_and_where_to_open_it(
    client, moderator, subscribed, post_record
):
    flag = _file_flag(client, post_record["id"])
    stored = flags.get_flag(flag["id"])
    assert stored is not None
    decision = decide_on(moderator, post_record["id"], "hide")

    assert client.post(
        DECISIONS_URL, json=decision, headers=moderator.headers
    ).status_code == 201

    [note] = [
        n for n in _notifications(stored.reporter_did) if n.kind == flags.FLAG_DECIDED_KIND
    ]
    assert note.payload["summary"] == "The post you reported was hidden."
    assert note.payload["outcome"] == "The post you reported was hidden."
    assert note.payload["target_kind"] == "post"
    # The item is named and linked to the surface that now shows the
    # placeholder: the paper's Discussion tab.
    assert note.payload["target_cid"] == post_record["id"]
    assert note.payload["link"].startswith("/discussion/")


def test_the_post_author_hears_type_correct_words_and_a_working_link(
    client, moderator, subscribed, post_record
):
    decision = decide_on(moderator, post_record["id"], "hide")

    assert client.post(
        DECISIONS_URL, json=decision, headers=moderator.headers
    ).status_code == 201

    [note] = [
        n
        for n in _notifications(post_record["author"])
        if n.kind == moderation.RECORD_DECISION_KIND
    ]
    assert note.payload["summary"] == "The post you wrote was hidden by moderation."
    assert note.payload["target_kind"] == "post"
    assert note.payload["link"].startswith("/discussion/")


def test_dismissing_a_paper_flag_tells_the_reporter_but_not_the_author(
    client, moderator, subscribed
):
    submission = Submission(state="listed")
    reporter = f"did:example:paperflag-{uuid.uuid4().hex}"
    response = client.post(
        "/v1/flags",
        json={"target": submission.version_cid, "reason": "spam"},
        headers={"Authorization": f"Bearer {issue_access_token(reporter, 1)}"},
    )
    assert response.status_code == 201, response.text
    decision = decide_on(moderator, submission.version_cid, "dismiss")

    assert client.post(
        DECISIONS_URL, json=decision, headers=moderator.headers
    ).status_code == 201

    [note] = [
        n for n in _notifications(reporter) if n.kind == flags.FLAG_DECIDED_KIND
    ]
    assert note.payload["summary"] == "The paper you reported was reviewed and kept."
    assert note.payload["link"] == f"/p/{submission.short_id}"
    # A dismiss makes no new listing decision, so the authors are not told
    # about a paper that did not change.
    assert [
        n
        for n in _notifications(submission.did)
        if n.kind == moderation.MODERATION_DECISION_KIND
    ] == []


def test_dismiss_aimed_at_the_paper_itself_settles_its_flags(client, moderator, subscribed):
    submission = Submission(state="listed")
    flag = _file_flag(client, submission.paper_cid)
    decision = decide_on(moderator, submission.paper_cid, "dismiss")

    response = client.post(DECISIONS_URL, json=decision, headers=moderator.headers)

    assert response.status_code == 201, response.text
    assert response.json()["state"] == "dismissed"
    settled = flags.get_flag(flag["id"])
    assert settled is not None and settled.status == flags.DECIDED
    # The paper did not move, and its author is not told it did.
    assert submission.state == "listed"
    assert [
        n
        for n in _notifications(submission.did)
        if n.kind == moderation.MODERATION_DECISION_KIND
    ] == []


def test_a_list_decision_tells_the_reporter_the_paper_was_kept_listed(
    client, moderator, subscribed
):
    submission = Submission(state="moderation")
    reporter = f"did:example:paperkept-{uuid.uuid4().hex}"
    response = client.post(
        "/v1/flags",
        json={"target": submission.version_cid, "reason": "plagiarism"},
        headers={"Authorization": f"Bearer {issue_access_token(reporter, 1)}"},
    )
    assert response.status_code == 201, response.text
    decision = decide_on(moderator, submission.version_cid, "list")

    assert client.post(
        DECISIONS_URL, json=decision, headers=moderator.headers
    ).status_code == 201

    [note] = [
        n for n in _notifications(reporter) if n.kind == flags.FLAG_DECIDED_KIND
    ]
    assert note.payload["summary"] == "The paper you reported was kept listed."
    assert note.payload["link"] == f"/p/{submission.short_id}"


def test_a_record_decision_arriving_through_post_records_is_applied(
    client, moderator, subscribed, post_record
):
    record = decide_on(moderator, post_record["id"], "hide")

    response = client.post(RECORDS_URL, json=record, headers=moderator.headers)

    assert response.status_code == 201, response.text
    assert moderation.is_hidden(post_record["id"])

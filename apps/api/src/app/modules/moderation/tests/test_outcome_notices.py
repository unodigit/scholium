"""What a reporter is told about a decided flag, and what /mod counts.

Journey 07 found three things wrong with the moderation outcome surfaces:

* the reporter's notice named only the item type and carried the raw reason
  code: "The post you reported was hidden." plus ``duplicated-figures``.  It
  must name the paper and quote the start of the flagged text, and say the
  reason in words -- from one mapping, :data:`outcomes.REASON_LABELS`, that the console
  reads the same way;
* a moderator deciding a flag on a paper that is already listed was still
  offered "List the paper".  The console needs the version's state to leave it
  out, so ``GET /v1/moderation/targets/{cid}`` answers it (tier 4 only);
* ``/mod`` showed no decided count.  ``GET /v1/moderation/flag-counts`` answers
  the open flags and the flags decided in the last seven days.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from app import db
from app.modules import flags, ledger
from app.modules.moderation.models import ModerationDecision, ensure_tables
from app.modules.moderation import outcomes
from app.modules.moderation.tests.test_decisions import (
    DECISIONS_URL,
    Submission,
    client,  # noqa: F401 - fixture re-exports
    moderator,  # noqa: F401 - fixture re-exports
    subscribed,  # noqa: F401 - fixture re-exports
)
from app.modules.moderation.tests.test_record_decisions import (
    RecordAuthor,
    _notifications,
    decide_on,
)
from app.security import issue_access_token

flags.ensure_tables()


def _file(client, target: str, reason: str) -> tuple[str, str]:
    """File a flag as a fresh reporter; returns ``(flag id, reporter did)``."""
    reporter = f"did:example:notice-{uuid.uuid4().hex}"
    response = client.post(
        "/v1/flags",
        json={"target": target, "reason": reason},
        headers={"Authorization": f"Bearer {issue_access_token(reporter, 1)}"},
    )
    assert response.status_code == 201, response.text
    return response.json()["id"], reporter


def _post_saying(text: str, submission: Submission) -> dict:
    """A signed ``discussion.post`` with exactly ``text`` on ``submission``'s paper."""
    author = RecordAuthor()
    record = author.sign(
        "discussion.post",
        {
            "target": submission.version_cid,
            "anchor": submission.version_cid,
            "text": text,
            "parent": None,
            "paper": submission.paper_cid,
        },
    )
    ledger.append(record)
    return record


def _reporter_note(reporter: str) -> Any:
    [note] = [n for n in _notifications(reporter) if n.kind == flags.FLAG_DECIDED_KIND]
    return note


# --------------------------------------------------------------------------- #
# The reporter's notice
# --------------------------------------------------------------------------- #


def test_the_notice_names_the_paper_and_labels_the_reporters_category(
    client, moderator, subscribed
):
    submission = Submission(state="listed")
    post = _post_saying("A short reply that fits well inside the excerpt.", submission)
    flag_id, reporter = _file(client, post["id"], "duplicated-figures")
    decision = decide_on(
        moderator, post["id"], "hide", reason="The figures are the authors' own."
    )

    assert client.post(
        DECISIONS_URL, json=decision, headers=moderator.headers
    ).status_code == 201

    note = _reporter_note(reporter)
    assert note.payload["summary"] == (
        f'The post you reported as "Duplicated figures" on "{submission.title}" '
        "was hidden. Moderator's note: The figures are the authors' own."
    )
    assert note.payload["outcome"] == note.payload["summary"]
    # The reason shown beside the sentence is the reporter's label, never the code...
    assert note.payload["reason"] == "Duplicated figures"
    # ...which stays available to a client that wants it.
    assert note.payload["reason_code"] == "duplicated-figures"
    assert note.payload["flag_id"] == flag_id


def test_a_long_post_notice_carries_the_moderators_note_without_the_excerpt(
    client, moderator, subscribed
):
    submission = Submission(state="listed")
    text = "".join(f"word{index:02d} " for index in range(40))  # 280 characters
    post = _post_saying(text, submission)
    _, reporter = _file(client, post["id"], "off-topic")
    decision = decide_on(moderator, post["id"], "dismiss", reason="The thread stays.")

    assert client.post(
        DECISIONS_URL, json=decision, headers=moderator.headers
    ).status_code == 201

    assert _reporter_note(reporter).payload["summary"] == (
        f'The post you reported as "Off topic" on "{submission.title}" '
        "was reviewed and kept. Moderator's note: The thread stays."
    )


def test_a_paper_notice_names_the_paper_and_the_reason_in_words(client, moderator, subscribed):
    submission = Submission(state="listed")
    _, reporter = _file(client, submission.version_cid, "misleading")
    decision = decide_on(
        moderator, submission.version_cid, "dismiss", reason="The claim is supported."
    )

    assert client.post(
        DECISIONS_URL,
        json=decision,
        headers=moderator.headers,
    ).status_code == 201

    note = _reporter_note(reporter)
    assert note.payload["summary"] == (
        'The paper you reported as "Misleading or false" was reviewed and kept listed. '
        "Moderator's note: The claim is supported."
    )
    assert note.payload["reason"] == "Misleading or false"
    assert note.payload["link"] == f"/p/{submission.short_id}"


def test_a_review_notice_names_the_review_and_the_moderators_note(
    client, moderator, subscribed
):
    submission = Submission(state="listed")
    report = "The reviewer's report: the method is sound but the figures repeat."
    review = RecordAuthor().sign(
        "review.formal",
        {
            "target": submission.version_cid,
            "paper": submission.paper_cid,
            "scores": {
                d: {"score": 3, "justification": "fine"}
                for d in ("soundness", "evidence", "reproducibility", "novelty", "clarity", "limitations")
            },
            "confidence": "high",
            "recommendation": "minor_revisions",
            "report": report,
            "commitment": uuid.uuid4().hex,
        },
    )
    ledger.append(review)
    _, reporter = _file(client, review["id"], "misconduct")
    decision = decide_on(
        moderator, review["id"], "hide", reason="The report names a participant."
    )

    assert client.post(
        DECISIONS_URL, json=decision, headers=moderator.headers
    ).status_code == 201

    assert _reporter_note(reporter).payload["summary"] == (
        f'The review you reported as "Research misconduct" on "{submission.title}" '
        "was hidden. Moderator's note: The report names a participant."
    )


def test_the_reporters_category_is_theirs_and_the_note_is_the_moderators(
    client, moderator, subscribed
):
    """Regression (journey 07): a kept notice misattributed the two reasons.

    The reporter's category belongs after "reported as", and the moderator's
    own reason -- taken from the decision record -- is the note.  Before this,
    the sentence ended "was reviewed and kept: Off topic.", which read as the
    reason for keeping and never showed what the moderator said.
    """
    submission = Submission(state="listed")
    post = _post_saying("A reply that stays up.", submission)
    _, reporter = _file(client, post["id"], "off-topic")
    decision = decide_on(moderator, post["id"], "dismiss", reason="The post is on topic.")

    assert client.post(
        DECISIONS_URL, json=decision, headers=moderator.headers
    ).status_code == 201

    summary = _reporter_note(reporter).payload["summary"]
    assert summary == (
        f'The post you reported as "Off topic" on "{submission.title}" '
        "was reviewed and kept. Moderator's note: The post is on topic."
    )
    # The reporter's own category is never offered as the reason for keeping.
    assert "kept: Off topic" not in summary


def test_a_hidden_notice_carries_the_moderators_note(client, moderator, subscribed):
    submission = Submission(state="listed")
    post = _post_saying("A reply that goes.", submission)
    _, reporter = _file(client, post["id"], "duplicated-figures")
    decision = decide_on(moderator, post["id"], "hide", reason="The figures are original.")

    assert client.post(
        DECISIONS_URL, json=decision, headers=moderator.headers
    ).status_code == 201

    assert _reporter_note(reporter).payload["summary"] == (
        f'The post you reported as "Duplicated figures" on "{submission.title}" '
        "was hidden. Moderator's note: The figures are original."
    )


def test_a_kept_paper_notice_carries_the_moderators_note(client, moderator, subscribed):
    submission = Submission(state="listed")
    _, reporter = _file(client, submission.version_cid, "misleading")
    decision = decide_on(
        moderator, submission.version_cid, "dismiss", reason="The claim is supported."
    )

    assert client.post(
        DECISIONS_URL, json=decision, headers=moderator.headers
    ).status_code == 201

    assert _reporter_note(reporter).payload["summary"] == (
        'The paper you reported as "Misleading or false" was reviewed and kept listed. '
        "Moderator's note: The claim is supported."
    )


# --------------------------------------------------------------------------- #
# One mapping of reason codes to words
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("code", "label"),
    [
        ("duplicated-figures", "Duplicated figures"),
        ("off-topic", "Off topic"),
        ("misleading", "Misleading or false"),
        ("spam", "Spam or advertising"),
        ("abuse", "Harassment or abuse"),
        ("legal", "Legal problem"),
        ("misconduct", "Research misconduct"),
        ("plagiarism", "Plagiarism"),
        ("other", "Something else"),
    ],
)
def test_every_reason_the_reporter_panels_offer_has_a_label(code, label):
    assert outcomes.REASON_LABELS[code] == label
    assert outcomes.reason_label(code) == label


def test_a_reason_code_nobody_mapped_reads_as_a_sentence_not_a_code():
    assert outcomes.reason_label("bad_faith") == "Bad faith"
    assert outcomes.reason_label("  ") == "No reason given"


# --------------------------------------------------------------------------- #
# GET /v1/moderation/flag-counts
# --------------------------------------------------------------------------- #

COUNTS_URL = "/v1/moderation/flag-counts"


def _decided_flag(*, decided_ago: timedelta) -> None:
    """A flag settled by a decision that is dated ``decided_ago`` before now."""
    ensure_tables()
    flag = flags.create_flag(
        target_cid=f"bafy-counts-{uuid.uuid4().hex}",
        reporter_did=f"did:example:counts-{uuid.uuid4().hex}",
        reason="spam",
    )
    decision_cid = f"bafy-decision-{uuid.uuid4().hex}"
    with db.SessionLocal() as session:
        session.add(
            ModerationDecision(
                decision_cid=decision_cid,
                target_cid=flag.target_cid,
                action="dismiss",
                clause="MOD-01",
                moderator_did="did:example:counts-moderator",
                decided_at=(datetime.now(timezone.utc) - decided_ago).replace(tzinfo=None),
            )
        )
        session.commit()
    flags.decide_flag(flag.id, decision_cid)


def _open_flag() -> None:
    flags.create_flag(
        target_cid=f"bafy-counts-{uuid.uuid4().hex}",
        reporter_did=f"did:example:counts-{uuid.uuid4().hex}",
        reason="spam",
    )


def test_the_counts_say_how_many_flags_are_open_and_how_many_were_decided_this_week(
    client, moderator
):
    before = client.get(COUNTS_URL, headers=moderator.headers)
    assert before.status_code == 200, before.text
    base = before.json()

    _open_flag()
    _open_flag()
    _decided_flag(decided_ago=timedelta(days=1))
    _decided_flag(decided_ago=timedelta(days=6, hours=23))
    _decided_flag(decided_ago=timedelta(days=8))  # outside the window

    after = client.get(COUNTS_URL, headers=moderator.headers).json()

    assert after["open"] == base["open"] + 2
    assert after["decided_last_7_days"] == base["decided_last_7_days"] + 2
    assert after["window_days"] == 7


def test_the_counts_are_for_moderators_only(client):
    member = issue_access_token(f"did:example:member-{uuid.uuid4().hex}", 1)

    response = client.get(COUNTS_URL, headers={"Authorization": f"Bearer {member}"})

    assert response.status_code == 403
    assert client.get(COUNTS_URL).status_code in (401, 403)


# --------------------------------------------------------------------------- #
# GET /v1/moderation/targets/{cid}
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("state", ["listed", "moderation", "held"])
def test_a_version_target_reports_its_state(client, moderator, state):
    submission = Submission(state=state)

    response = client.get(
        f"/v1/moderation/targets/{submission.version_cid}", headers=moderator.headers
    )

    assert response.status_code == 200, response.text
    assert response.json() == {"cid": submission.version_cid, "kind": "version", "state": state}


def test_a_post_target_has_no_state(client, moderator):
    post = _post_saying("A post.", Submission(state="listed"))

    response = client.get(f"/v1/moderation/targets/{post['id']}", headers=moderator.headers)

    assert response.status_code == 200, response.text
    assert response.json() == {"cid": post["id"], "kind": "record", "state": None}


def test_an_unknown_target_is_a_404(client, moderator):
    response = client.get("/v1/moderation/targets/bafy-nobody-holds-this", headers=moderator.headers)

    assert response.status_code == 404


def test_the_target_state_is_for_moderators_only(client):
    submission = Submission(state="listed")
    member = issue_access_token(f"did:example:member-{uuid.uuid4().hex}", 1)

    response = client.get(
        f"/v1/moderation/targets/{submission.version_cid}",
        headers={"Authorization": f"Bearer {member}"},
    )

    assert response.status_code == 403

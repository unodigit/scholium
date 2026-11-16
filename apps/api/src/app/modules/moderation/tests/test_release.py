"""Tests for the ``release`` moderation action (moderation plugin).

An overturned appeal returns a version to the state the appealed decision found
it in.  It does so with a ``release`` record that *names* that state, not with
the action that would normally lead to it: a ``list`` for a version that was
never listed would put an approval nobody made into the public log, and whoever
replays the log would list the version.  The moderation subscriber maps a
``release`` to exactly the state it names.
"""

from __future__ import annotations

import pytest
from scholium_record_core import validate_body

from app.modules import ledger, submissions
from app.modules.moderation import (
    ACTION_STATES,
    ACTIONS,
    RELEASE,
    RELEASE_STATES,
    DecisionNotAllowed,
    decision_fields,
    decision_state,
    get_decision,
    handle_moderation_decision,
)

from .test_decisions import (  # noqa: F401 - fixture re-exports
    DECISIONS_URL,
    RECORDS_URL,
    Submission,
    _problem,
    client,
    moderator,
    subscribed,
)


def test_release_is_an_action_but_not_a_state_setting_one():
    assert RELEASE == "release" and RELEASE in ACTIONS
    # The action does not imply a state: the record names it.
    assert RELEASE not in ACTION_STATES


@pytest.mark.parametrize("state", RELEASE_STATES)
def test_the_published_schema_accepts_a_release_naming_a_state(state):
    body = {"target": "bafy", "action": "release", "state": state, "clause": "MOD-01", "reason": "r"}
    assert validate_body("moderation.decision", body) == []


def test_the_published_schema_refuses_a_release_naming_an_unknown_state():
    body = {"target": "bafy", "action": "release", "state": "scanning", "clause": "MOD-01", "reason": "r"}
    assert validate_body("moderation.decision", body) != []


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ({"action": "list"}, "listed"),
        ({"action": "hold"}, "held"),
        ({"action": "reject"}, "rejected"),
        ({"action": "delist"}, "rejected"),
        ({"action": "reclassify", "category": "cs.LG"}, None),
        ({"action": "tombstone"}, None),
        ({"action": "release", "state": "moderation"}, "moderation"),
        ({"action": "release", "state": "listed"}, "listed"),
        ({"action": "release", "state": "held"}, "held"),
        ({"action": "release", "state": "rejected"}, "rejected"),
        ({"action": "release"}, None),
        ({"action": "release", "state": "scanning"}, None),
        ({"action": ["list"]}, None),
        ({}, None),
    ],
)
def test_decision_state_is_the_state_a_decision_leaves_its_target_in(body, expected):
    assert decision_state(body) == expected
    assert decision_state(None) is None


@pytest.mark.parametrize("start", ["held", "rejected"])
def test_a_release_puts_the_version_in_the_moderation_queue_and_never_lists_it(client, moderator, start):
    submission = Submission(state=start)

    response = moderator.post(client, submission, "release", state="moderation")

    assert response.status_code == 201, response.text
    assert response.json()["state"] == "moderation"
    assert submission.state == "moderation"
    version = submissions.get_version(submission.version_cid)
    assert version.listed_at is None
    assert submissions.get_paper(submission.paper_cid).latest_version_cid is None
    assert get_decision(response.json()["id"]).action == "release"


def test_a_release_to_listed_lists_a_version_a_decision_had_taken_out(client, moderator):
    submission = Submission(state="held")

    response = moderator.post(client, submission, "release", state="listed")

    assert response.status_code == 201, response.text
    assert submission.state == "listed"


def test_a_release_back_to_held_is_the_state_it_names(client, moderator):
    submission = Submission(state="rejected")

    assert moderator.post(client, submission, "release", state="held").status_code == 201
    assert submission.state == "held"


def test_the_subscriber_applies_a_release_that_reaches_the_node_through_the_log(client, moderator, subscribed):
    submission = Submission(state="rejected")
    record = moderator.decide(submission, "release", state="moderation")

    response = client.post(RECORDS_URL, json=record, headers=moderator.headers)

    assert response.status_code == 201, response.text
    assert submission.state == "moderation"


def test_a_release_is_not_another_way_to_list_a_version_in_moderation(client, moderator):
    submission = Submission(state="moderation")

    problem = _problem(moderator.post(client, submission, "release", state="listed"), 409)

    assert submission.state == "moderation"
    assert problem["status"] == 409
    # Refused before anything was stored.
    assert not any(
        entry.body.get("action") == "release" and entry.body.get("target") == submission.version_cid
        for entry in ledger.entries()
        if entry.record_type == "moderation.decision" and isinstance(entry.body, dict)
    )


def test_handle_refuses_a_release_that_would_move_an_untouched_version():
    submission = Submission(state="listed")
    record = {
        "id": "bafy-release",
        "author": "did:key:z6Mk-moderator",
        "created": "2026-01-01T00:00:00Z",
        "body": {
            "target": submission.version_cid,
            "action": "release",
            "state": "moderation",
            "clause": "MOD-01",
            "reason": "r",
        },
    }
    with pytest.raises(DecisionNotAllowed):
        handle_moderation_decision(record)


def test_a_release_without_a_state_is_422(client, moderator):
    submission = Submission(state="held")

    problem = _problem(moderator.post(client, submission, "release"), 422)

    assert submission.state == "held"
    assert "state" in str(problem)


def test_a_release_naming_a_state_it_cannot_return_to_is_422(client, moderator):
    submission = Submission(state="held")

    _problem(moderator.post(client, submission, "release", state="scanning"), 422)

    assert submission.state == "held"


def test_decision_fields_reads_the_state_a_release_names_and_only_for_a_release():
    record = {
        "id": "bafy",
        "author": "did:key:z6Mk",
        "created": "2026-01-01T00:00:00Z",
        "body": {"target": "t", "action": "release", "state": "moderation", "clause": "MOD-01", "reason": "r"},
    }
    assert decision_fields(record).state == "moderation"
    record["body"] = {"target": "t", "action": "hold", "state": "moderation", "clause": "MOD-01", "reason": "r"}
    assert decision_fields(record).state is None


def test_a_version_the_author_never_saw_listed_is_not_announced_as_listed(client, moderator):
    # Putting the version back in the queue must not emit a move to ``listed``:
    # that event tells the author their paper is listed and starts the advisory
    # AI pre-review of a newly listed version.
    from app.modules.submissions.events import subscribe_state_changed, unsubscribe_state_changed

    submission = Submission(state="rejected")
    seen: list[str] = []

    def collect(event) -> None:
        if event.version_cid == submission.version_cid:
            seen.append(event.state)

    subscribe_state_changed(collect)
    try:
        assert moderator.post(client, submission, "release", state="moderation").status_code == 201
    finally:
        unsubscribe_state_changed(collect)

    assert seen == ["moderation"]

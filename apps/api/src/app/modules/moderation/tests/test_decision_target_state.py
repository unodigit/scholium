"""Moderation decisions need a settled version and a downloadable ``reasonCid``.

A moderator's first chance to act on a version is once it has finished the
consent and scanning pipeline: a version in ``moderation``, or one a decision
has already settled (``listed``, ``held``, ``rejected``).  A version still
``awaiting_consent`` (or ``scanning``, or ``draft``) must answer ``409`` -- a
hold or reject there would settle a version its co-authors never agreed to
publish.  A ``tombstone`` stays exempt: a takedown must work in any state.

The reason a decision publishes is subject to the same rule as a notice's:
a ``reasonCid`` is accepted only when ``GET /v1/content`` would serve that file
to the moderator (stored, not tombstoned, visible, and scanned clean).
"""

from __future__ import annotations

import uuid

import pytest

from app.modules import content
from app.modules.moderation import get_decision

from .test_decisions import (  # noqa: F401 - fixture re-exports
    DECISIONS_URL,
    Submission,
    _problem,
    _stored,
    client,
    moderator,
)


@pytest.mark.parametrize("action", ["hold", "reject", "delist", "list", "reclassify"])
@pytest.mark.parametrize("state", ["awaiting_consent", "scanning"])
def test_a_decision_on_a_version_that_has_not_settled_is_409(client, moderator, action, state):
    kwargs = {"category": "cs.LG"} if action == "reclassify" else {}
    submission = Submission(state=state)
    decision = moderator.decide(submission, action, **kwargs)

    error = _problem(client.post(DECISIONS_URL, json=decision, headers=moderator.headers), 409)

    assert error["type"] == "urn:scholium:problem:decision-not-allowed"
    assert error["state"] == state
    assert submission.state == state
    assert not _stored(client, decision)
    assert get_decision(decision["id"]) is None


@pytest.mark.parametrize("action", ["hold", "reject"])
def test_holding_or_rejecting_a_version_awaiting_consent_is_409(client, moderator, action):
    """The reported symptom: a co-author's consent cannot be bypassed."""
    submission = Submission(state="awaiting_consent")
    decision = moderator.decide(submission, action)

    error = _problem(client.post(DECISIONS_URL, json=decision, headers=moderator.headers), 409)

    assert error["state"] == "awaiting_consent"
    assert error["requested"] == ("held" if action == "hold" else "rejected")
    assert submission.state == "awaiting_consent"


@pytest.mark.parametrize("action", ["hold", "reject", "list", "delist"])
def test_decisions_on_settled_states_are_unchanged(client, moderator, action):
    start = "listed" if action == "delist" else ("held" if action == "hold" else "moderation")
    submission = Submission(state=start)

    response = moderator.post(client, submission, action)

    assert response.status_code == 201, response.text


def test_a_list_decision_on_a_rejected_version_is_still_allowed(client, moderator):
    """``rejected`` is settled: relisting it is a moderator's call."""
    submission = Submission(state="rejected")

    assert moderator.post(client, submission, "list").status_code == 201
    assert submission.state == "listed"


@pytest.mark.parametrize("scan", [content.SCAN_SCANNING, content.SCAN_FAILED])
def test_a_reason_cid_the_moderator_could_not_download_is_refused(client, moderator, scan):
    blob = content.store_bytes(f"a reason the route would not serve {uuid.uuid4().hex}".encode())
    content.set_scan_status(blob.cid, scan)
    submission = Submission(state="moderation")
    decision = moderator.decide(submission, "reject", reason=None, reasonCid=blob.cid)

    served = client.get(f"/v1/content/{blob.cid}", headers=moderator.headers)
    assert served.status_code in (423, 451), served.text

    error = _problem(client.post(DECISIONS_URL, json=decision, headers=moderator.headers), 422)

    assert error["errors"][0]["loc"] == ["body", "reasonCid"]
    assert error["errors"][0]["type"] == "reason_not_readable"
    assert submission.state == "moderation"
    assert not _stored(client, decision)


def test_a_scanned_reason_cid_the_moderator_may_download_is_accepted(client, moderator):
    blob = content.store_bytes(f"a clean reason {uuid.uuid4().hex}".encode())
    content.set_scan_status(blob.cid, content.SCAN_PASSED)
    submission = Submission(state="moderation")
    decision = moderator.decide(submission, "reject", reason=None, reasonCid=blob.cid)

    response = client.post(DECISIONS_URL, json=decision, headers=moderator.headers)

    assert response.status_code == 201, response.text
    assert submission.state == "rejected"

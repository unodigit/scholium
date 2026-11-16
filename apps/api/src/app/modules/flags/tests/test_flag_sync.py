"""Tests for closing flags when a moderation decision is made (flag sync).

A moderation decision names a target, not a flag.  Once a decision has been
applied, every open flag on its target must be marked decided with the
decision's cid -- whichever door the decision came through
(``POST /v1/moderation/decisions`` or ``POST /v1/records``) -- and each
reporter told once.  A decision on a *version* also settles the flags filed
against that version's *paper*: a reader flags "the paper" while a moderator
decides on one of its versions.

Isolation note: the test database is shared by pytest-xdist workers, so every
test writes under its own unique DIDs and cids.
"""

from __future__ import annotations

import subprocess
import sys
import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.modules import flags, moderation
from app.modules.moderation import flag_sync
from app.modules.moderation.tests.test_decisions import DECISIONS_URL, Moderator, Submission
from app.security import issue_access_token

flags.ensure_tables()


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def subscribed():
    """Put the ledger subscriptions back.

    Both packages subscribe when they are imported, but other suites call
    ``ledger.clear_subscribers()`` around their tests, which removes them for
    the rest of the worker's life.  The moderation subscription goes first so
    the decision is applied before its flags are settled, as in the app.
    """
    moderation._install_ledger_subscriber()
    flag_sync.install_ledger_subscriber()


def _uid() -> str:
    return uuid.uuid4().hex


def _reporter() -> tuple[str, dict[str, str]]:
    did = f"did:example:flagsync-{_uid()}"
    return did, {"Authorization": f"Bearer {issue_access_token(did, 1)}"}


def _file(client, target: str, reason: str = "plagiarism") -> dict[str, Any]:
    _, headers = _reporter()
    response = client.post("/v1/flags", json={"target": target, "reason": reason}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


def _status(flag_id: str) -> tuple[str, Any]:
    flag = flags.get_flag(flag_id)
    assert flag is not None
    return flag.status, flag.decision_cid


# --- the decision closes the flags on its target ---------------------------


def test_a_decision_on_a_flagged_version_decides_its_open_flags(client):
    submission = Submission(state="listed")
    moderator = Moderator()
    flag = _file(client, submission.version_cid)
    decision = moderator.decide(submission, "hold")

    assert client.post(DECISIONS_URL, json=decision, headers=moderator.headers).status_code == 201

    assert _status(flag["id"]) == (flags.DECIDED, decision["id"])


def test_the_decided_flag_is_readable_through_the_api_with_its_decision_cid(client):
    submission = Submission(state="listed")
    moderator = Moderator()
    reporter_did, reporter_headers = _reporter()
    flag = client.post(
        "/v1/flags",
        json={"target": submission.version_cid, "reason": "spam"},
        headers=reporter_headers,
    ).json()
    decision = moderator.decide(submission, "hold")

    assert client.post(DECISIONS_URL, json=decision, headers=moderator.headers).status_code == 201

    body = client.get(f"/v1/flags/{flag['id']}", headers=reporter_headers).json()
    assert body["status"] == flags.DECIDED
    assert body["decision_cid"] == decision["id"]
    # ... and the moderator's list no longer carries it as open work.
    open_ids = [
        item["id"]
        for item in client.get(
            "/v1/flags", params={"target": submission.version_cid}, headers=moderator.headers
        ).json()
    ]
    assert flag["id"] not in open_ids
    decided = client.get(
        "/v1/flags",
        params={"target": submission.version_cid, "state": "decided"},
        headers=moderator.headers,
    ).json()
    assert [(item["id"], item["decision_cid"]) for item in decided] == [(flag["id"], decision["id"])]


def test_a_decision_on_a_version_decides_flags_filed_against_its_paper(client):
    submission = Submission(state="listed")
    moderator = Moderator()
    flag = _file(client, submission.paper_cid)
    decision = moderator.decide(submission, "hold")

    assert client.post(DECISIONS_URL, json=decision, headers=moderator.headers).status_code == 201

    assert _status(flag["id"]) == (flags.DECIDED, decision["id"])


def test_every_open_flag_on_the_target_is_decided_and_other_flags_are_left_alone(client):
    submission = Submission(state="listed")
    other = Submission(state="listed")
    moderator = Moderator()
    on_version = [_file(client, submission.version_cid)["id"], _file(client, submission.version_cid)["id"]]
    on_paper = _file(client, submission.paper_cid)["id"]
    elsewhere = _file(client, other.version_cid)["id"]
    elsewhere_paper = _file(client, other.paper_cid)["id"]
    decision = moderator.decide(submission, "hold")

    assert client.post(DECISIONS_URL, json=decision, headers=moderator.headers).status_code == 201

    for flag_id in (*on_version, on_paper):
        assert _status(flag_id) == (flags.DECIDED, decision["id"])
    assert _status(elsewhere) == ("pending", None)
    assert _status(elsewhere_paper) == ("pending", None)


def test_a_flag_decided_earlier_keeps_its_first_decision(client):
    submission = Submission(state="moderation")
    moderator = Moderator()
    flag = _file(client, submission.version_cid)

    first = moderator.decide(submission, "hold")
    assert client.post(DECISIONS_URL, json=first, headers=moderator.headers).status_code == 201
    second = moderator.decide(submission, "list")
    assert client.post(DECISIONS_URL, json=second, headers=moderator.headers).status_code == 201

    assert _status(flag["id"]) == (flags.DECIDED, first["id"])


def test_each_reporter_is_notified_once_when_the_decision_is_made(client):
    from app.modules.notifications import list_notifications

    submission = Submission(state="listed")
    moderator = Moderator()
    reporter_did, reporter_headers = _reporter()
    client.post(
        "/v1/flags",
        json={"target": submission.version_cid, "reason": "spam"},
        headers=reporter_headers,
    )
    decision = moderator.decide(submission, "reject")

    assert client.post(DECISIONS_URL, json=decision, headers=moderator.headers).status_code == 201

    [notification] = [n for n in list_notifications(reporter_did) if n.kind == flags.FLAG_DECIDED_KIND]
    assert notification.payload["decision_cid"] == decision["id"]
    assert notification.payload["status"] == flags.DECIDED


@pytest.mark.parametrize("action", ["list", "hold", "reject", "delist"])
def test_every_state_setting_action_decides_the_flags(client, action):
    submission = Submission(state="listed" if action == "delist" else "moderation")
    moderator = Moderator()
    flag = _file(client, submission.version_cid)
    decision = moderator.decide(submission, action)

    assert client.post(DECISIONS_URL, json=decision, headers=moderator.headers).status_code == 201

    assert _status(flag["id"]) == (flags.DECIDED, decision["id"])


def test_a_reclassify_decision_decides_the_flags_too(client):
    submission = Submission(state="listed")
    moderator = Moderator()
    flag = _file(client, submission.version_cid)
    decision = moderator.decide(submission, "reclassify", category="cs.LG")

    assert client.post(DECISIONS_URL, json=decision, headers=moderator.headers).status_code == 201

    assert _status(flag["id"]) == (flags.DECIDED, decision["id"])


def test_a_decision_arriving_through_post_records_decides_the_flags(client):
    submission = Submission(state="listed")
    moderator = Moderator()
    flag = _file(client, submission.version_cid)
    decision = moderator.decide(submission, "hold")

    response = client.post("/v1/records", json=decision, headers=moderator.headers)

    assert response.status_code == 201, response.text
    assert _status(flag["id"]) == (flags.DECIDED, decision["id"])


def test_a_version_decision_answers_the_flags_of_the_version_and_of_its_paper(client):
    submission = Submission(state="listed")

    assert flag_sync.flag_targets(submission.version_cid) == (
        submission.version_cid,
        submission.paper_cid,
    )


@pytest.mark.parametrize("kind", ["paper", "unknown"])
def test_a_paper_or_unknown_target_answers_only_its_own_flags(client, kind):
    # A tombstone may name a paper or a file id instead of a version; a post or
    # review cid is not a version either.  Only flags on that cid are settled.
    submission = Submission(state="listed")
    target = submission.paper_cid if kind == "paper" else f"bafyother{uuid.uuid4().hex}"

    assert flag_sync.flag_targets(target) == (target,)


# --- a decision that was not made leaves the flags open ---------------------


def test_a_refused_decision_leaves_the_flags_open(client):
    submission = Submission(state="listed")
    moderator = Moderator()
    flag = _file(client, submission.version_cid)
    unknown_clause = moderator.decide(submission, "hold", clause="NOT-A-CLAUSE")

    response = client.post(DECISIONS_URL, json=unknown_clause, headers=moderator.headers)

    assert response.status_code == 422, response.text
    assert _status(flag["id"]) == ("pending", None)


def test_a_decision_below_tier_4_leaves_the_flags_open(client):
    submission = Submission(state="listed")
    low = Moderator(tier=2, token_tier=2)
    flag = _file(client, submission.version_cid)

    response = client.post(DECISIONS_URL, json=low.decide(submission, "hold"), headers=low.headers)

    assert response.status_code == 403, response.text
    assert _status(flag["id"]) == ("pending", None)


# --- the sync function itself ----------------------------------------------


def test_sync_does_nothing_for_a_decision_that_was_not_applied(client, monkeypatch):
    submission = Submission(state="listed")
    moderator = Moderator()
    flag = _file(client, submission.version_cid)
    decision = moderator.decide(submission, "hold")

    def refuse(record):
        raise RuntimeError("could not apply")

    monkeypatch.setattr(flag_sync, "apply_decision", refuse)

    with pytest.raises(RuntimeError):
        flag_sync.sync_flags_for_decision(decision)

    assert _status(flag["id"]) == ("pending", None)


def test_sync_is_idempotent(client):
    submission = Submission(state="listed")
    moderator = Moderator()
    flag = _file(client, submission.version_cid)
    decision = moderator.decide(submission, "hold")
    assert client.post(DECISIONS_URL, json=decision, headers=moderator.headers).status_code == 201

    assert flag_sync.sync_flags_for_decision(decision) == []

    assert _status(flag["id"]) == (flags.DECIDED, decision["id"])


# --- wiring ------------------------------------------------------------------


def test_the_app_subscribes_the_sync_to_moderation_decisions_on_its_own():
    # A fresh interpreter: the autouse fixture above would hide a missing
    # import-time subscription.  Loading the app's modules (as the module
    # loader does) must be enough for decisions to settle their flags.  The
    # subscribers are read *before* anything imports ``flag_sync`` by name,
    # because importing it is itself what installs the subscription.
    script = (
        "import importlib, pkgutil, app.modules as m;"
        "[importlib.import_module(i.name) for i in pkgutil.iter_modules(m.__path__, 'app.modules.')];"
        "from app.modules.ledger import service;"
        "names = [f'{fn.__module__}.{fn.__name__}' for fn in service._subscribers.get('moderation.decision', [])];"
        "assert 'app.modules.moderation.decisions.persist_entry' in names, names;"
        "assert 'app.modules.moderation.flag_sync.persist_flags_entry' in names, names"
    )
    result = subprocess.run(
        [sys.executable, "-I", "-c", script], capture_output=True, text=True, timeout=120
    )

    assert result.returncode == 0, result.stderr

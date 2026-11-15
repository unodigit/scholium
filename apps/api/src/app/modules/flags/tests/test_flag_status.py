"""Tests for ``GET /v1/flags/{id}`` and notifying the reporter when decided (feature 78).

Covers: the endpoint returning a flag's status and linked decision cid (and the
404/401 contracts, and who may read a flag), deciding a flag through
:func:`decide_flag` / :func:`decide_flags_for_target`, and the reporter's
``flag.decided`` notification -- sent once, to the reporter only, and never at
the cost of the decision itself.

Isolation note: the test database is shared by pytest-xdist workers, so every
test writes under its own unique DIDs and cids.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.modules import flags
from app.modules.flags import service
from app.modules.notifications import list_notifications
from app.security import UNAUTHENTICATED_TYPE, issue_access_token

flags.ensure_tables()
client = TestClient(app)


def _uid() -> str:
    return uuid.uuid4().hex


def _did() -> str:
    return f"did:example:flag-{_uid()}"


def _cid() -> str:
    return f"bafyflag{_uid()}"


def _auth(did: str, tier: int = 1) -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access_token(did, tier)}"}


def _file(reporter: str, target: str | None = None) -> dict:
    """File a flag through the public endpoint and return the response body."""
    response = client.post(
        "/v1/flags",
        json={"target": target or _cid(), "reason": "spam"},
        headers=_auth(reporter),
    )
    assert response.status_code == 201, response.text
    return response.json()


def _decided_notifications(did: str) -> list:
    return [n for n in list_notifications(did) if n.kind == flags.FLAG_DECIDED_KIND]


# --- GET /v1/flags/{id} ------------------------------------------------------


def test_get_requires_authentication():
    response = client.get(f"/v1/flags/{_uid()}")

    assert response.status_code == 401
    assert response.json()["type"] == UNAUTHENTICATED_TYPE


def test_get_unknown_flag_is_404_problem():
    response = client.get(f"/v1/flags/{_uid()}", headers=_auth(_did()))

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["status"] == 404


def test_get_pending_flag_returns_status_and_no_decision():
    reporter = _did()
    created = _file(reporter)

    response = client.get(f"/v1/flags/{created['id']}", headers=_auth(reporter))

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == created["id"]
    assert body["status"] == "pending"
    assert body["decision_cid"] is None
    assert body["target_cid"] == created["target_cid"]
    assert body["reason"] == "spam"


def test_get_decided_flag_returns_status_and_linked_decision_cid():
    reporter = _did()
    flag_id = _file(reporter)["id"]
    decision_cid = _cid()

    flags.decide_flag(flag_id, decision_cid)

    body = client.get(f"/v1/flags/{flag_id}", headers=_auth(reporter)).json()
    assert body["status"] == flags.DECIDED
    assert body["decision_cid"] == decision_cid
    assert body["decisionCid"] == decision_cid


def test_get_by_another_member_is_404_even_though_the_flag_exists():
    reporter = _did()
    flag_id = _file(reporter)["id"]

    response = client.get(f"/v1/flags/{flag_id}", headers=_auth(_did(), tier=3))

    assert response.status_code == 404


def test_get_by_a_moderator_is_allowed():
    reporter = _did()
    flag_id = _file(reporter)["id"]

    response = client.get(f"/v1/flags/{flag_id}", headers=_auth(_did(), tier=4))

    assert response.status_code == 200
    assert response.json()["id"] == flag_id


# --- deciding a flag notifies the reporter ----------------------------------


def test_deciding_a_flag_notifies_the_reporter_once_with_the_decision():
    reporter = _did()
    created = _file(reporter)
    decision_cid = _cid()
    assert _decided_notifications(reporter) == []

    decided = flags.decide_flag(created["id"], decision_cid)

    assert decided is not None
    assert decided.status == flags.DECIDED
    assert decided.decision_cid == decision_cid
    [notification] = _decided_notifications(reporter)
    assert notification.read is False
    assert notification.payload == {
        "flag_id": created["id"],
        "target_cid": created["target_cid"],
        "reason": "spam",
        "status": flags.DECIDED,
        "decision_cid": decision_cid,
    }


def test_reporter_sees_the_notification_through_the_notifications_api():
    reporter = _did()
    flag_id = _file(reporter)["id"]

    flags.decide_flag(flag_id, _cid())

    response = client.get("/v1/me/notifications", headers=_auth(reporter))
    assert response.status_code == 200
    kinds = [n["kind"] for n in response.json()]
    assert kinds.count(flags.FLAG_DECIDED_KIND) == 1


def test_no_notification_while_the_flag_is_pending():
    reporter = _did()
    flag_id = _file(reporter)["id"]

    client.get(f"/v1/flags/{flag_id}", headers=_auth(reporter))

    assert _decided_notifications(reporter) == []


def test_deciding_twice_keeps_the_first_decision_and_notifies_once():
    reporter = _did()
    flag_id = _file(reporter)["id"]
    first, second = _cid(), _cid()

    assert flags.decide_flag(flag_id, first) is not None
    assert flags.decide_flag(flag_id, second) is None

    assert flags.get_flag(flag_id).decision_cid == first
    assert len(_decided_notifications(reporter)) == 1


def test_deciding_an_unknown_flag_does_nothing():
    assert flags.decide_flag(_uid(), _cid()) is None


def test_decided_status_can_be_chosen_by_the_caller():
    reporter = _did()
    flag_id = _file(reporter)["id"]

    flags.decide_flag(flag_id, _cid(), status="dismissed")

    assert client.get(f"/v1/flags/{flag_id}", headers=_auth(reporter)).json()["status"] == "dismissed"
    [notification] = _decided_notifications(reporter)
    assert notification.payload["status"] == "dismissed"


@pytest.mark.parametrize(
    "kwargs",
    [
        {"decision_cid": ""},
        {"decision_cid": "   "},
        {"decision_cid": None},
        {"status": "pending"},
        {"status": ""},
    ],
)
def test_invalid_arguments_are_rejected_and_leave_the_flag_pending(kwargs):
    reporter = _did()
    flag_id = _file(reporter)["id"]
    args = {"decision_cid": _cid(), **kwargs}

    with pytest.raises(ValueError):
        flags.decide_flag(flag_id, **args)

    assert flags.get_flag(flag_id).status == "pending"
    assert _decided_notifications(reporter) == []


def test_a_failing_notification_does_not_undo_the_decision(monkeypatch):
    reporter = _did()
    flag_id = _file(reporter)["id"]
    decision_cid = _cid()

    def boom(*args, **kwargs):
        raise RuntimeError("notification store is down")

    monkeypatch.setattr(service, "notify", boom)

    decided = flags.decide_flag(flag_id, decision_cid)

    assert decided is not None
    stored = flags.get_flag(flag_id)
    assert (stored.status, stored.decision_cid) == (flags.DECIDED, decision_cid)


# --- one decision, many flags ----------------------------------------------


def test_decide_flags_for_target_decides_only_pending_flags_on_that_target():
    target, other_target = _cid(), _cid()
    alice, bob, carol = _did(), _did(), _did()
    on_target_a = _file(alice, target)["id"]
    on_target_b = _file(bob, target)["id"]
    elsewhere = _file(carol, other_target)["id"]
    already = _file(carol, target)["id"]
    earlier_decision, decision_cid = _cid(), _cid()
    flags.decide_flag(already, earlier_decision)

    decided = flags.decide_flags_for_target(target, decision_cid)

    assert sorted(f.id for f in decided) == sorted([on_target_a, on_target_b])
    assert flags.get_flag(on_target_a).decision_cid == decision_cid
    assert flags.get_flag(on_target_b).decision_cid == decision_cid
    assert flags.get_flag(elsewhere).status == "pending"
    assert flags.get_flag(already).decision_cid == earlier_decision
    assert len(_decided_notifications(alice)) == 1
    assert len(_decided_notifications(bob)) == 1
    # carol's only notification is for the flag decided earlier, not this call
    assert len(_decided_notifications(carol)) == 1
    assert _decided_notifications(carol)[0].payload["flag_id"] == already


def test_decide_flags_for_target_with_nothing_pending_returns_empty():
    assert flags.decide_flags_for_target(_cid(), _cid()) == []


def test_repeating_decide_flags_for_target_does_not_notify_again():
    target = _cid()
    reporter = _did()
    _file(reporter, target)

    assert len(flags.decide_flags_for_target(target, _cid())) == 1
    assert flags.decide_flags_for_target(target, _cid()) == []

    assert len(_decided_notifications(reporter)) == 1

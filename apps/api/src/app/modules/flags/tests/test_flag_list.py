"""Tests for ``GET /v1/flags`` -- the moderators' list of flags.

The mod console (``apps/web/src/features/mod-console/flags.ts``) reads the
flags it shows from ``GET /v1/flags``.  That route used to be missing: the path
answered ``405`` (only ``POST`` was mounted), so a filed flag never reached a
moderator.  The list is tier 4 only, answers open flags by default, and can be
filtered by ``state`` and ``target``.

Isolation note: the test database is shared by pytest-xdist workers, so every
test writes under its own unique DIDs and cids and only looks for its own rows.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.modules import flags
from app.security import UNAUTHENTICATED_TYPE, issue_access_token

flags.ensure_tables()
client = TestClient(app)


def _uid() -> str:
    return uuid.uuid4().hex


def _did() -> str:
    return f"did:example:flaglist-{_uid()}"


def _cid() -> str:
    return f"bafyflaglist{_uid()}"


def _auth(did: str, tier: int = 1) -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access_token(did, tier)}"}


def _moderator() -> dict[str, str]:
    return _auth(_did(), tier=4)


def _file(target: str | None = None, reason: str = "spam") -> dict:
    response = client.post(
        "/v1/flags",
        json={"target": target or _cid(), "reason": reason},
        headers=_auth(_did()),
    )
    assert response.status_code == 201, response.text
    return response.json()


def _list(headers: dict[str, str], **params: str):
    return client.get("/v1/flags", params=params, headers=headers)


def _ids(response) -> list[str]:
    assert response.status_code == 200, response.text
    return [item["id"] for item in response.json()]


# --- who may list ------------------------------------------------------------


def test_listing_requires_authentication():
    response = client.get("/v1/flags")

    assert response.status_code == 401
    assert response.json()["type"] == UNAUTHENTICATED_TYPE


@pytest.mark.parametrize("tier", [0, 1, 2, 3])
def test_listing_is_forbidden_below_tier_4(tier):
    _file()

    response = _list(_auth(_did(), tier=tier))

    assert response.status_code == 403
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["caller_tier"] == tier


# --- what a moderator gets ---------------------------------------------------


def test_a_filed_flag_is_listed_for_a_moderator():
    flag = _file(reason="plagiarism")

    response = _list(_moderator(), target=flag["target_cid"])

    assert response.status_code == 200
    [listed] = response.json()
    # The same item shape as ``GET /v1/flags/{id}`` and ``POST /v1/flags``.
    assert listed == flag
    assert listed["status"] == "pending"
    assert listed["decision_cid"] is None
    assert listed["reason"] == "plagiarism"


def test_the_list_without_filters_holds_every_open_flag():
    first, second = _file(), _file()

    ids = _ids(_list(_moderator()))

    assert {first["id"], second["id"]} <= set(ids)


def test_the_list_is_a_json_array_the_console_can_parse():
    _file()

    body = _list(_moderator()).json()

    assert isinstance(body, list)
    assert all({"id", "target_cid", "status", "decision_cid"} <= set(item) for item in body)


# --- filters -----------------------------------------------------------------


def test_target_filter_returns_only_flags_on_that_target():
    target = _cid()
    on_target = [_file(target)["id"], _file(target)["id"]]
    elsewhere = _file()["id"]

    ids = _ids(_list(_moderator(), target=target))

    assert sorted(ids) == sorted(on_target)
    assert elsewhere not in ids


def test_open_flags_are_the_default_and_decided_ones_drop_out_of_it():
    target = _cid()
    open_flag = _file(target)["id"]
    settled = _file(target)["id"]
    decision_cid = _cid()
    flags.decide_flag(settled, decision_cid)

    assert _ids(_list(_moderator(), target=target)) == [open_flag]
    assert _ids(_list(_moderator(), target=target, state="open")) == [open_flag]
    assert _ids(_list(_moderator(), target=target, state="pending")) == [open_flag]


def test_state_decided_lists_settled_flags_with_their_decision_cid():
    target = _cid()
    _file(target)
    settled = _file(target)["id"]
    decision_cid = _cid()
    flags.decide_flag(settled, decision_cid)

    response = _list(_moderator(), target=target, state="decided")

    assert response.status_code == 200
    [listed] = response.json()
    assert listed["id"] == settled
    assert listed["status"] == flags.DECIDED
    assert listed["decision_cid"] == decision_cid
    assert listed["decisionCid"] == decision_cid


def test_state_decided_includes_flags_decided_with_another_status():
    target = _cid()
    dismissed = _file(target)["id"]
    flags.decide_flag(dismissed, _cid(), status="dismissed")

    assert _ids(_list(_moderator(), target=target, state="decided")) == [dismissed]
    assert _ids(_list(_moderator(), target=target, state="dismissed")) == [dismissed]
    assert _ids(_list(_moderator(), target=target, state="open")) == []


def test_state_all_lists_open_and_decided_flags():
    target = _cid()
    open_flag = _file(target)["id"]
    settled = _file(target)["id"]
    flags.decide_flag(settled, _cid())

    ids = _ids(_list(_moderator(), target=target, state="all"))

    assert sorted(ids) == sorted([open_flag, settled])


def test_a_blank_filter_is_ignored():
    flag = _file()

    assert flag["id"] in _ids(_list(_moderator(), state="", target=""))


def test_the_flag_lookup_by_id_still_works_next_to_the_list():
    flag = _file()

    response = client.get(f"/v1/flags/{flag['id']}", headers=_moderator())

    assert response.status_code == 200
    assert response.json()["id"] == flag["id"]

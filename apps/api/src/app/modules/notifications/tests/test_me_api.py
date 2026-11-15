"""Tests for the /v1/me/notifications API (feature 58).

Covers: ``GET /v1/me/notifications`` returning the caller's unread and read
notifications (and nobody else's), ``POST /v1/me/notifications/{id}/read``
marking one read (idempotently, and only the caller's own), authentication
on both routes, and the error contracts (401/404/422 as RFC 9457 problem
documents).

Isolation note: the test database is shared by pytest-xdist workers, so each
test writes under its own unique DID instead of assuming an empty table.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.modules.notifications import ensure_table, notify
from app.security import UNAUTHENTICATED_TYPE, issue_access_token

ensure_table()
client = TestClient(app)


def _did() -> str:
    """A DID unique to this test, so parallel workers never see each other's rows."""
    return f"did:example:me-{uuid.uuid4().hex}"


def _auth(did: str, tier: int = 1) -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access_token(did, tier)}"}


def _problem(response) -> dict:
    """Assert the body is an RFC 9457 problem document and return it."""
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    assert body["status"] == response.status_code
    assert body["title"]
    return body


# --- authentication ---------------------------------------------------------


@pytest.mark.parametrize(
    "method,path",
    [("get", "/v1/me/notifications"), ("post", "/v1/me/notifications/1/read")],
)
def test_both_routes_require_authentication(method, path):
    response = getattr(client, method)(path)

    assert response.status_code == 401
    body = _problem(response)
    assert body["type"] == UNAUTHENTICATED_TYPE
    assert response.headers["www-authenticate"] == "Bearer"


def test_a_malformed_token_is_rejected_like_a_missing_one():
    response = client.get("/v1/me/notifications", headers={"Authorization": "Bearer not-a-jwt"})

    assert response.status_code == 401
    _problem(response)


@pytest.mark.parametrize("tier", range(5))
def test_every_tier_may_read_their_own_notifications(tier):
    did = _did()
    notify(did, "digest", {"n": 1})

    response = client.get("/v1/me/notifications", headers=_auth(did, tier))

    assert response.status_code == 200
    assert [row["kind"] for row in response.json()] == ["digest"]


# --- GET /v1/me/notifications ------------------------------------------------


def test_list_returns_unread_and_read_notifications_oldest_first():
    did = _did()
    first = notify(did, "consent.request", {"paper_cid": "bafyrei1"})
    second = notify(did, "digest", {"email": "someone@example.org"})

    marked = client.post(f"/v1/me/notifications/{first.id}/read", headers=_auth(did))
    assert marked.status_code == 200

    response = client.get("/v1/me/notifications", headers=_auth(did))

    assert response.status_code == 200
    body = response.json()
    assert [row["id"] for row in body] == [first.id, second.id]
    assert [row["read"] for row in body] == [True, False]
    for row in body:
        assert set(row) == {"id", "did", "kind", "payload", "read"}
        assert row["did"] == did


def test_list_round_trips_the_payload():
    did = _did()
    payload = {"paper_cid": "bafyrei2", "link": "https://x.test/c", "nested": {"a": [1, 2]}}
    notify(did, "consent.request", payload)

    response = client.get("/v1/me/notifications", headers=_auth(did))

    assert response.json()[0]["payload"] == payload


def test_list_only_returns_the_callers_notifications():
    alice, bob = _did(), _did()
    notify(alice, "for-alice", {"n": 1})
    notify(bob, "for-bob", {"n": 2})

    response = client.get("/v1/me/notifications", headers=_auth(alice))

    assert response.status_code == 200
    body = response.json()
    assert [row["kind"] for row in body] == ["for-alice"]
    assert all(row["did"] == alice for row in body)


def test_list_is_empty_for_an_account_without_notifications():
    response = client.get("/v1/me/notifications", headers=_auth(_did()))

    assert response.status_code == 200
    assert response.json() == []


# --- POST /v1/me/notifications/{id}/read --------------------------------------


def test_mark_read_returns_the_notification_now_read():
    did = _did()
    notification = notify(did, "consent.request", {"paper_cid": "bafyrei3"})

    response = client.post(f"/v1/me/notifications/{notification.id}/read", headers=_auth(did))

    assert response.status_code == 200
    body = response.json()
    assert body == {
        "id": notification.id,
        "did": did,
        "kind": "consent.request",
        "payload": {"paper_cid": "bafyrei3"},
        "read": True,
    }

    listed = client.get("/v1/me/notifications", headers=_auth(did)).json()
    assert [row["read"] for row in listed] == [True]


def test_mark_read_is_idempotent():
    did = _did()
    notification = notify(did, "digest")

    for _ in range(2):
        response = client.post(f"/v1/me/notifications/{notification.id}/read", headers=_auth(did))
        assert response.status_code == 200
        assert response.json()["read"] is True

    assert [row["read"] for row in client.get("/v1/me/notifications", headers=_auth(did)).json()] == [True]


def test_mark_read_of_an_unknown_id_is_a_404_problem():
    did = _did()

    response = client.post("/v1/me/notifications/999999999/read", headers=_auth(did))

    assert response.status_code == 404
    body = _problem(response)
    assert body["instance"] == "/v1/me/notifications/999999999/read"
    assert "999999999" in body["detail"]


def test_mark_read_cannot_touch_another_accounts_notification():
    alice, bob = _did(), _did()
    bobs = notify(bob, "for-bob", {"n": 1})

    response = client.post(f"/v1/me/notifications/{bobs.id}/read", headers=_auth(alice))

    assert response.status_code == 404
    _problem(response)
    bobs_rows = [row for row in client.get("/v1/me/notifications", headers=_auth(bob)).json()]
    assert [row["read"] for row in bobs_rows] == [False]


def test_mark_read_of_a_non_integer_id_is_a_422_problem():
    did = _did()

    response = client.post("/v1/me/notifications/not-an-int/read", headers=_auth(did))

    assert response.status_code == 422
    body = _problem(response)
    assert isinstance(body["errors"], list) and body["errors"]

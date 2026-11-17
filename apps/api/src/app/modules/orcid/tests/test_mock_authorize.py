"""Tests for the API-served mock ORCID consent page (``ORCID_MOCK=1``).

In mock mode ``GET /v1/auth/orcid/start`` must not send the browser to the real
ORCID sandbox: no client registration exists in dev, so a sandbox URL with a
blank ``client_id`` could never complete.  It points at
``GET /v1/auth/orcid/mock/authorize`` instead, which renders a fake consent
screen for a test iD and redirects to the web app's ``/onboarding/orcid`` page
with ``code=mock-<orcid>`` and the *original* state -- so linking exercises the
same whole-page return path as the real ORCID flow.

The page is unavailable when mock mode is off, and it only redirects back to an
origin ``WEB_ORIGINS`` lists.
"""

from __future__ import annotations

import uuid
from urllib.parse import parse_qs, urlsplit

import pytest

from app.modules.orcid import MOCK_AUTHORIZE_PATH, MOCK_ORCID_ID
from app.modules.orcid.models import Credential, ensure_tables
from app.security import issue_access_token
from app.settings import settings
from app import db

START = "/v1/auth/orcid/start"
COMPLETE = "/v1/auth/orcid/complete"
MOCK = MOCK_AUTHORIZE_PATH
REDIRECT = "http://localhost:3000/onboarding/orcid"
PROBLEM_JSON = "application/problem+json"


@pytest.fixture(autouse=True)
def mock_orcid(monkeypatch):
    monkeypatch.setattr(settings, "ORCID_MOCK", 1)
    monkeypatch.setattr(settings, "WEB_ORIGINS", "http://localhost:3000")
    monkeypatch.setattr(settings, "ORCID_CLIENT_ID", "APP-TESTCLIENT")


def new_did() -> str:
    return f"did:key:z6Mk{uuid.uuid4().hex}"


def bearer(did: str, tier: int = 0) -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access_token(did, tier)}"}


def query(url: str) -> dict[str, str]:
    return {k: v[0] for k, v in parse_qs(urlsplit(url).query, keep_blank_values=True).items()}


def start(client, did: str) -> tuple[str, str]:
    """Start the flow as ``did``; return ``(authorize_url, state)``."""
    response = client.get(START, headers=bearer(did))
    assert response.status_code == 200, response.text
    body = response.json()
    return body["authorize_url"], body["state"]


def path_and_query(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.path}?{parts.query}"


def assert_problem(response, status: int) -> dict:
    assert response.status_code == status, response.text
    assert response.headers["content-type"].startswith(PROBLEM_JSON), response.headers
    body = response.json()
    assert body["status"] == status, body
    return body


# --- where /start sends the browser ----------------------------------------


def test_start_sends_the_browser_to_this_nodes_mock_page(client):
    url, state = start(client, new_did())

    parts = urlsplit(url)
    assert parts.path == MOCK
    params = query(url)
    assert params["redirect_uri"] == REDIRECT
    assert params["state"] == state
    assert "sandbox.orcid.org" not in url


# --- the consent screen -----------------------------------------------------


def test_consent_page_shows_a_fake_orcid_id_and_keeps_the_state(client):
    url, state = start(client, new_did())

    response = client.get(path_and_query(url))

    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/html")
    assert response.headers["cache-control"] == "no-store"
    body = response.text
    assert MOCK_ORCID_ID in body
    assert state in body
    assert 'name="decision" value="approve"' in body
    assert 'name="decision" value="deny"' in body
    assert "Mock ORCID" in body


def test_consent_page_escapes_untrusted_query_values(client):
    response = client.get(
        MOCK,
        params={"redirect_uri": REDIRECT, "state": '"><script>alert(1)</script>'},
    )

    assert response.status_code == 200, response.text
    assert "<script>alert(1)</script>" not in response.text
    assert "&lt;script&gt;" in response.text


# --- approving and denying --------------------------------------------------


def test_approving_redirects_back_with_a_mock_code_and_the_original_state(client):
    url, state = start(client, new_did())

    response = client.get(f"{path_and_query(url)}&decision=approve", follow_redirects=False)

    assert response.status_code == 302
    location = response.headers["location"]
    parts = urlsplit(location)
    assert (parts.scheme, parts.netloc, parts.path) == ("http", "localhost:3000", "/onboarding/orcid")
    params = query(location)
    assert params["code"] == f"mock-{MOCK_ORCID_ID}"
    assert params["state"] == state


def test_denying_redirects_back_with_access_denied_and_the_state(client):
    url, state = start(client, new_did())

    response = client.get(f"{path_and_query(url)}&decision=deny", follow_redirects=False)

    assert response.status_code == 302
    params = query(response.headers["location"])
    assert params["error"] == "access_denied"
    assert params["state"] == state
    assert "code" not in params


# --- the whole round trip, through the real return path ---------------------


def test_the_mock_round_trip_links_the_iD_to_the_signed_in_user(client, node_key):
    did = new_did()
    url, state = start(client, did)

    approved = client.get(f"{path_and_query(url)}&decision=approve", follow_redirects=False)
    returned = query(approved.headers["location"])

    completed = client.post(
        COMPLETE,
        json={"code": returned["code"], "state": returned["state"]},
        headers=bearer(did),
    )

    assert completed.status_code == 200, completed.text
    assert completed.json()["credentialSubject"] == {"id": did, "orcid": MOCK_ORCID_ID}
    ensure_tables()
    with db.SessionLocal() as session:
        assert session.query(Credential).count() == 1


# --- safety -----------------------------------------------------------------


def test_redirect_uri_must_be_on_a_configured_web_origin(client):
    response = client.get(
        MOCK,
        params={"redirect_uri": "https://evil.example/steal", "state": "s"},
    )

    assert_problem(response, 400)
    assert "WEB_ORIGINS" in response.json()["detail"]


def test_a_missing_state_is_refused(client):
    response = client.get(MOCK, params={"redirect_uri": REDIRECT, "state": " "})

    assert_problem(response, 400)


def test_the_mock_page_is_not_served_when_mock_mode_is_off(client, monkeypatch):
    monkeypatch.setattr(settings, "ORCID_MOCK", 0)

    response = client.get(MOCK, params={"redirect_uri": REDIRECT, "state": "s"})

    assert_problem(response, 404)


def test_an_allowed_origin_is_not_enough_if_the_path_is_not_the_return_page(client):
    response = client.get(
        MOCK,
        params={"redirect_uri": "http://localhost:3000/elsewhere", "state": "s"},
    )

    assert_problem(response, 400)

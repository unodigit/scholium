"""Tests for ``GET /v1/auth/orcid/start`` (feature 31).

Covers: the route being mounted by the module loader, the authorize URL and its
OAuth parameters, the sandbox default and ``ORCID_BASE_URL`` overrides, the
signed ``state`` (verifiable, expiring, unique, purpose-bound, tamper-proof),
binding the caller's DID from a bearer token (and never from the query
string), and the configuration/authentication error contracts.

``settings`` is a process-wide singleton, so every test that changes it does so
through ``monkeypatch``.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import jwt
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.modules.orcid import (
    DEFAULT_ORCID_BASE_URL,
    STATE_PURPOSE,
    STATE_TTL,
    InvalidState,
    orcid_base_url,
    sign_state,
    verify_state,
)
from app.security import (
    UNAUTHENTICATED_TYPE,
    InvalidAccessToken,
    decode_access_token,
    issue_access_token,
)
from app.settings import settings

START = "/v1/auth/orcid/start"
SRC = Path(__file__).resolve().parents[4]  # apps/api/src

client = TestClient(app)


@pytest.fixture
def orcid_env(monkeypatch):
    """Mock mode, a client id, and ORCID_BASE_URL unset (settings' own fallback)."""
    monkeypatch.delenv("ORCID_BASE_URL", raising=False)
    monkeypatch.setattr(settings, "ORCID_BASE_URL", "https://orcid.org")
    monkeypatch.setattr(settings, "ORCID_CLIENT_ID", "APP-TESTCLIENT")
    monkeypatch.setattr(settings, "ORCID_MOCK", 1)
    monkeypatch.setattr(settings, "WEB_ORIGINS", "http://localhost:3000")
    return settings


def _start(headers: dict[str, str] | None = None, **params):
    return client.get(START, headers=headers, params=params)


def _query(url: str) -> dict[str, str]:
    return {k: v[0] for k, v in parse_qs(urlsplit(url).query, keep_blank_values=True).items()}


def _bearer(did: str, tier: int = 0) -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access_token(did, tier)}"}


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


# --- routing ----------------------------------------------------------------


def test_route_is_mounted_by_the_module_loader():
    # The OpenAPI schema lists mounted operations without depending on how this
    # FastAPI version nests included routers inside ``app.routes``.
    assert "get" in client.get("/openapi.json").json()["paths"][START]


# --- the authorize URL ------------------------------------------------------


def test_returns_the_sandbox_authorize_url_with_oauth_parameters(orcid_env, monkeypatch):
    # Real mode: the URL is ORCID's, with a registered client id.
    monkeypatch.setattr(settings, "ORCID_MOCK", 0)

    response = _start()

    assert response.status_code == 200
    body = response.json()
    url = body["authorize_url"]
    parts = urlsplit(url)
    assert (parts.scheme, parts.netloc, parts.path) == ("https", "sandbox.orcid.org", "/oauth/authorize")
    query = _query(url)
    assert query["client_id"] == "APP-TESTCLIENT"
    assert query["response_type"] == "code"
    assert query["scope"] == "/authenticate"
    # ORCID sends the browser to the web app, which finishes the link as the
    # signed-in user -- never to an unauthenticated API endpoint.
    assert query["redirect_uri"] == "http://localhost:3000/onboarding/orcid"
    assert query["state"] == body["state"]


def test_mock_mode_points_at_the_api_consent_page_with_the_same_parameters(orcid_env):
    """ORCID_MOCK must not send the browser to the real sandbox.

    No client id is registered in dev, so a sandbox URL with a blank
    ``client_id`` can never complete.  The URL instead names this node's mock
    consent page, carrying the redirect and signed state the real one would.
    """
    response = _start()

    assert response.status_code == 200
    body = response.json()
    url = body["authorize_url"]
    parts = urlsplit(url)
    assert parts.netloc == "testserver", url
    assert parts.path == "/v1/auth/orcid/mock/authorize"
    query = _query(url)
    assert query["response_type"] == "code"
    assert query["scope"] == "/authenticate"
    assert query["redirect_uri"] == "http://localhost:3000/onboarding/orcid"
    assert query["state"] == body["state"]


def test_every_url_spelling_carries_the_same_value(orcid_env):
    body = _start().json()

    assert set(body) == {"authorize_url", "authorization_url", "url", "auth_url", "state"}
    assert body["authorization_url"] == body["url"] == body["auth_url"] == body["authorize_url"]


def test_response_is_not_cacheable(orcid_env):
    assert _start().headers["cache-control"] == "no-store"


# --- ORCID_BASE_URL ---------------------------------------------------------


def test_defaults_to_the_sandbox_when_the_variable_is_unset(orcid_env):
    assert orcid_base_url() == DEFAULT_ORCID_BASE_URL == "https://sandbox.orcid.org"


def test_default_holds_for_the_real_settings_in_a_fresh_process():
    """No monkeypatching: ``app.settings`` really falls back to production, we must not."""
    env = {k: v for k, v in os.environ.items() if k != "ORCID_BASE_URL"}
    env["PYTHONPATH"] = str(SRC)
    probe = (
        "from app.settings import settings; from app.modules.orcid import orcid_base_url;"
        "print(settings.ORCID_BASE_URL, orcid_base_url())"
    )

    result = subprocess.run([sys.executable, "-c", probe], env=env, capture_output=True, text=True, timeout=60)

    assert result.returncode == 0, result.stderr
    assert result.stdout.split() == ["https://orcid.org", "https://sandbox.orcid.org"]


def test_blank_setting_falls_back_to_the_sandbox(orcid_env, monkeypatch):
    monkeypatch.setattr(settings, "ORCID_MOCK", 0)
    monkeypatch.setattr(settings, "ORCID_BASE_URL", "   ")

    assert urlsplit(_start().json()["authorize_url"]).netloc == "sandbox.orcid.org"


def test_production_is_used_when_the_operator_sets_it_explicitly(orcid_env, monkeypatch):
    monkeypatch.setattr(settings, "ORCID_MOCK", 0)
    monkeypatch.setenv("ORCID_BASE_URL", "https://orcid.org")

    parts = urlsplit(_start().json()["authorize_url"])

    assert (parts.netloc, parts.path) == ("orcid.org", "/oauth/authorize")


@pytest.mark.parametrize(
    "configured, expected_prefix",
    [
        ("https://orcid.example.test", "https://orcid.example.test/oauth/authorize?"),
        ("https://orcid.example.test/", "https://orcid.example.test/oauth/authorize?"),
        ("https://orcid.example.test/oauth/authorize", "https://orcid.example.test/oauth/authorize?"),
        ("http://localhost:9000/orcid/", "http://localhost:9000/orcid/oauth/authorize?"),
    ],
)
def test_honours_a_configured_base_url(orcid_env, monkeypatch, configured, expected_prefix):
    monkeypatch.setattr(settings, "ORCID_MOCK", 0)
    monkeypatch.setattr(settings, "ORCID_BASE_URL", configured)

    assert _start().json()["authorize_url"].startswith(expected_prefix)


# --- the signed state -------------------------------------------------------


def test_state_is_a_signed_expiring_orcid_state(orcid_env):
    state = _start().json()["state"]

    assert jwt.get_unverified_header(state)["alg"] == "HS256"
    claims = verify_state(state)
    assert claims["purpose"] == STATE_PURPOSE
    assert claims["exp"] - claims["iat"] == int(STATE_TTL.total_seconds()) == 600
    assert abs(claims["iat"] - datetime.now(timezone.utc).timestamp()) < 60
    assert claims["nonce"] and claims["jti"]
    assert "did" not in claims


def test_every_call_gets_a_different_state(orcid_env):
    states = {_start().json()["state"] for _ in range(5)}

    assert len(states) == 5


def test_state_survives_url_encoding_round_trip(orcid_env):
    body = _start().json()

    assert verify_state(_query(body["authorize_url"])["state"])["jti"] == verify_state(body["state"])["jti"]


def test_a_tampered_state_is_refused(orcid_env):
    header, payload, signature = _start().json()["state"].split(".")
    claims = json.loads(_unb64(payload))
    claims["did"] = "did:example:forged"
    forged = ".".join([header, _b64(json.dumps(claims, separators=(",", ":")).encode()), signature])

    with pytest.raises(InvalidState):
        verify_state(forged)


def test_a_state_signed_with_another_secret_is_refused(orcid_env):
    claims = verify_state(sign_state())
    forged = jwt.encode(claims, "not-the-node-secret", algorithm="HS256")

    with pytest.raises(InvalidState):
        verify_state(forged)


def test_an_unsigned_state_is_refused(orcid_env):
    claims = verify_state(sign_state())
    unsigned = jwt.encode(claims, None, algorithm="none")

    with pytest.raises(InvalidState):
        verify_state(unsigned)


def test_an_expired_state_is_refused(orcid_env):
    long_ago = datetime.now(timezone.utc) - STATE_TTL - timedelta(minutes=1)

    with pytest.raises(InvalidState, match="expired"):
        verify_state(sign_state(now=long_ago))


@pytest.mark.parametrize("value", ["", "not-a-jwt", "a.b.c"])
def test_garbage_state_is_refused(value):
    with pytest.raises(InvalidState):
        verify_state(value)


def test_an_access_token_is_not_accepted_as_a_state():
    with pytest.raises(InvalidState):
        verify_state(issue_access_token("did:example:alice", 1))


def test_a_state_is_not_accepted_as_an_access_token(orcid_env):
    with pytest.raises(InvalidAccessToken):
        decode_access_token(_start().json()["state"])


# --- binding the caller's DID -----------------------------------------------


def test_a_bearer_token_binds_its_did_into_the_state(orcid_env):
    claims = verify_state(_start(_bearer("did:example:alice")).json()["state"])

    assert claims["did"] == "did:example:alice"


def test_a_did_in_the_query_string_is_never_signed(orcid_env):
    """Unauthenticated callers must not be able to start a flow for someone else's DID."""
    anonymous = verify_state(_start(did="did:example:victim").json()["state"])
    authenticated = verify_state(_start(_bearer("did:example:alice"), did="did:example:victim").json()["state"])

    assert "did" not in anonymous
    assert authenticated["did"] == "did:example:alice"


def test_blank_did_parameter_is_harmless(orcid_env):
    assert _start(did="").status_code == 200


@pytest.mark.parametrize(
    "authorization",
    ["Bearer not-a-real-token", f"Bearer {jwt.encode({'sub': 'x'}, 'wrong', algorithm='HS256')}"],
)
def test_an_unusable_bearer_token_is_a_401_problem(orcid_env, authorization):
    response = _start({"Authorization": authorization})

    assert response.status_code == 401
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["type"] == UNAUTHENTICATED_TYPE
    assert response.headers["www-authenticate"] == 'Bearer error="invalid_token"'


def test_an_expired_bearer_token_is_a_401_problem(orcid_env):
    stale = issue_access_token("did:example:alice", 1, now=datetime.now(timezone.utc) - timedelta(hours=1))

    assert _start({"Authorization": f"Bearer {stale}"}).status_code == 401


# --- configuration ----------------------------------------------------------


def test_mock_mode_allows_a_blank_client_id(orcid_env, monkeypatch):
    monkeypatch.setattr(settings, "ORCID_CLIENT_ID", "")

    response = _start()

    assert response.status_code == 200
    assert _query(response.json()["authorize_url"])["client_id"] == ""


def test_real_mode_without_a_client_id_is_a_503_problem(orcid_env, monkeypatch):
    monkeypatch.setattr(settings, "ORCID_MOCK", 0)
    monkeypatch.setattr(settings, "ORCID_CLIENT_ID", " ")

    response = _start()

    assert response.status_code == 503
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    assert body["status"] == 503
    assert "ORCID_CLIENT_ID" in body["detail"]


def test_real_mode_with_a_client_id_works(orcid_env, monkeypatch):
    monkeypatch.setattr(settings, "ORCID_MOCK", 0)

    assert _start().status_code == 200
